/**
 * KiCad boards (.kicad_pcb, KiCad 6 and later) and footprints (.kicad_mod) as AD documents:
 * footprints become components with their pads (rounded rectangles, slots and custom shapes
 * kept), graphics, designator and comment; tracks, arcs and vias; zones polygon pours with
 * KiCad's own fill as their copper (repourable), rule areas keep-outs, teardrops copper regions;
 * the Edge.Cuts outline the board shape (other loops cut-outs); the copper layers and stack-up
 * the layer stack; KiCad's 3D models linked by name (found as STEP files in the model folders).
 * Layers as AD has them [est: AD's own KiCad importer's mapping]: F/B.SilkS → Top/Bottom Overlay,
 * F/B.Mask → Solder, F/B.Paste → Paste, Edge.Cuts → Mechanical 1, Dwgs.User → 2, Cmts.User → 3,
 * Eco1/2 → 4/5, Margin → 6, F/B.Adhes → 9/10, F/B.Fab → 13/14, F/B.CrtYd → 15/16, User.n → 20+n.
 */
import { writeMechLayout } from '../../model/pcbBoard';
import { newBoardRecord, defaultStack } from '../altium/board6';
import type { PcbRawRecord } from '../altium/framing';
import { applyStackLayers, assemblePcbDoc } from '../altium/assemble';
import { PropertyBag } from '../altium/props';
import { encodeArc, encodeBody, encodePad, encodeRegion, encodeText, encodeTrack, encodeVia, flattenVertices, layerToName, writePcbDoc, writeVertices } from '../altium/pcbdoc';
import { newPolygonProps } from '../altium/polygonProps';
import { newRule, type PcbRule } from '../altium/rules';
import { newBoardClasses, newBoardRules } from '../altium/newBoard';
import { readPcbLib, writePcbLib, type FootprintDef } from '../altium/pcblib';
import { altiumFloat } from '../altium/pcbTransform';
import { strokeTextWidth } from '../gerber/stroke';
import { L, mechLayer, type LayerId } from '../../model/layers';
import { formatAltiumLength, mil, mm } from '../../core/units';
import { pointInPoly, type Vec2 } from '../../core/geom';
import type { PcbDocument, PolyVertex } from '../../model/pcb';
import { at, flag, isList, kid, kids, num, parseSexpr, prop, pts, str, val, valNum, type SList } from './sexpr';
import { kicadNetKeys } from './netName';
import { keepJson, padToBoard, primOf, primShapes, type ApertureKept, type Prim } from './padPrims';
import { extrasOf, keepFootprint, libFootprintSig, vertexSig, keepId, keepWhole, sealFootprints, writeFootprintStore, zoneSig } from './kept';
import { PAD_SHAPE_KEY, grownShape } from '../../model/padShapes';
import { FLAG, PAD, get, put } from '../altium/pcbLayouts';

/* ── layers ── */

const MECH = (n: number): LayerId => mechLayer(n);
const NON_COPPER: Record<string, LayerId> = {
  'F.SilkS': L.TOP_OVERLAY, 'B.SilkS': L.BOTTOM_OVERLAY, 'F.Mask': L.TOP_SOLDER, 'B.Mask': L.BOTTOM_SOLDER, 'F.Paste': L.TOP_PASTE, 'B.Paste': L.BOTTOM_PASTE,
  'Edge.Cuts': MECH(1), 'Dwgs.User': MECH(2), 'Cmts.User': MECH(3), 'Eco1.User': MECH(4), 'Eco2.User': MECH(5), Margin: MECH(6),
  'F.Adhes': MECH(9), 'B.Adhes': MECH(10), 'F.Fab': MECH(13), 'B.Fab': MECH(14), 'F.CrtYd': MECH(15), 'B.CrtYd': MECH(16),
};
/** A KiCad layer name as AD's layer (copper by its place in the stack). */
export function layerMap(copper: string[]): (name: string) => LayerId | null {
  return (name: string) => {
    if (name === 'F.Cu') return L.TOP;
    if (name === 'B.Cu') return L.BOTTOM;
    const m = /^In(\d+)\.Cu$/.exec(name);
    if (m) { const i = Number(m[1]); return i >= 1 && i <= 30 && copper.includes(name) ? (L.MID1 + i - 1) as LayerId : null; }
    const u = /^User\.(\d+)$/.exec(name);
    if (u) return MECH(20 + Number(u[1]));
    return NON_COPPER[name] ?? null;
  };
}

/** KiCad's text markup taken off: ^{sup}, _{sub}, ~{overbar} keep their text. */
export const plainText = (s: string): string => s.replace(/[\^_~]\{([^{}]*)\}/g, '$1');

/* ── geometry ── */

type Xy = { x: number; y: number };
/** KiCad's footprint placement: local (Y down) turned anticlockwise by `angle` (degrees, as seen) and moved to `at`. */
function placer(origin: Xy, angle: number): (p: Xy) => Xy {
  const r = (angle * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return (p) => ({ x: origin.x + p.x * c + p.y * s, y: origin.y - p.x * s + p.y * c });
}
/** The circle through three points (KiCad's start/mid/end) in AD's frame: centre, radius, anticlockwise from start to end. */
export function arc3(a: Vec2, m: Vec2, b: Vec2): { c: Vec2; r: number; start: number; end: number } | null {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y));
  if (Math.abs(d) < 1e-6) return null;
  const sq = (p: Vec2) => p.x * p.x + p.y * p.y;
  const c = { x: (sq(a) * (m.y - b.y) + sq(m) * (b.y - a.y) + sq(b) * (a.y - m.y)) / d, y: (sq(a) * (b.x - m.x) + sq(m) * (a.x - b.x) + sq(b) * (m.x - a.x)) / d };
  const ang = (p: Vec2) => ((Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI + 360) % 360;
  let s = ang(a), e = ang(b);
  const ccw = (x: number) => ((x - s) % 360 + 360) % 360;
  if (ccw(ang(m)) > ccw(e)) [s, e] = [e, s];
  return { c: { x: Math.round(c.x), y: Math.round(c.y) }, r: Math.round(Math.hypot(a.x - c.x, a.y - c.y)), start: Math.round(s * 1000) / 1000, end: Math.round(e * 1000) / 1000 };
}


/** (pts …) with its arcs as AD's vertices (an arc vertex runs round to the next one), each point through `to`. */
export function ring(n: SList | undefined, to: (p: Xy) => Vec2): PolyVertex[] {
  const out: PolyVertex[] = [];
  const push = (v: PolyVertex) => { const l = out[out.length - 1]; if (l && !l.arc && Math.abs(l.p.x - v.p.x) <= 1 && Math.abs(l.p.y - v.p.y) <= 1) out[out.length - 1] = v; else out.push(v); };
  for (const it of kid(n, 'pts')?.items ?? []) {
    if (!isList(it)) continue;
    if (it.k === 'xy') push({ p: to({ x: num(it, 0), y: num(it, 1) }) });
    else if (it.k === 'arc') {
      const g = (k: string) => { const l = kid(it, k); return to({ x: num(l, 0), y: num(l, 1) }); };
      const a = g('start'), b = g('end'), c = arc3(a, g('mid'), b);
      push(c ? { p: a, arc: { c: c.c, r: c.r, sa: c.start, ea: c.end } } : { p: a });
      out.push({ p: b });
    }
  }
  // The closing point repeated
  const f = out[0], l = out[out.length - 1];
  if (out.length > 1 && f && l && !l.arc && Math.abs(l.p.x - f.p.x) <= 1 && Math.abs(l.p.y - f.p.y) <= 1) out.pop();
  return out;
}
const flat = (n: SList | undefined, to: (p: Xy) => Vec2): Vec2[] => flattenVertices(ring(n, to));
/** A custom pad's mask opening past its shape: the board's Solder Mask Expansion rule as the import makes it (newBoardRules), as its anchor pad has. */
const MASK_EXPANSION = mil(4);

/* ── the board ── */

export interface KicadRules {
  clearance?: number; trackWidth?: number; viaDiameter?: number; viaDrill?: number; minTrack?: number; minClearance?: number; minVia?: number; minDrill?: number; holeToHole?: number; copperEdge?: number;
  /** Net classes: their nets by name, or by KiCad's patterns (wildcards * and ?). */
  classes?: { name: string; clearance?: number; trackWidth?: number; viaDiameter?: number; viaDrill?: number; nets: string[]; patterns?: string[] }[];
}
export interface BoardResult { bytes: Uint8Array; warnings: string[]; /** The footprints it uses, by their library's name (as "Library:Footprint" gives it). */ footprints: Map<string, FootprintDef[]>; stats: { components: number; tracks: number; vias: number; pours: number } }

const guidOf = (seed: string): string => {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < seed.length; i++) { h1 = Math.imul(h1 ^ seed.charCodeAt(i), 16777619); h2 = Math.imul(h2 + seed.charCodeAt(i), 2246822519); }
  const hex = (n: number, l: number) => (n >>> 0).toString(16).toUpperCase().padStart(8, '0').slice(0, l);
  return `{${hex(h1, 8)}-${hex(h2, 4)}-${hex(h1 ^ h2, 4)}-${hex(h2 * 3, 4)}-${hex(h1 * 7, 8)}${hex(h2 * 11, 4)}}`;
};
/** AD's 8-letter unique ID for a KiCad symbol by its path (sheet instance and symbol UUID). */
export function uniqueIdFor(path: string): string {
  let h = 2166136261, g = 5381;
  for (let i = 0; i < path.length; i++) { h = Math.imul(h ^ path.charCodeAt(i), 16777619); g = (Math.imul(g, 33) + path.charCodeAt(i)) | 0; }
  let s = '';
  for (let i = 0; i < 8; i++) { const v = i < 4 ? (h >>> (i * 7)) : (g >>> ((i - 4) * 7)); s += String.fromCharCode(65 + (Math.abs(v) % 26)); }
  return s;
}

/** What a board's reading leaves out. */
export const BOARD_SKIP = new Set(['uuid', 'tstamp']);
/** A pad's lists the import makes something of (the rest kept: extrasOf). */
const PAD_USED = new Set(['at', 'size', 'drill', 'layers', 'net', 'roundrect_rratio', 'primitives', 'options', 'remove_unused_layers']);
/** A footprint's lists the import makes something of, or that are kept elsewhere (its items, its fields: keepFootprint). */
const FP_USED = new Set(['layer', 'at', 'descr', 'path', 'attr', 'pad', 'locked', 'placed', 'fp_line', 'fp_arc', 'fp_circle', 'fp_rect', 'fp_poly', 'fp_curve', 'fp_text',
  // (in the board's places, not the footprint's: kept with the part, KICADFPABS; its rule areas as keep-outs; a picture not kept yet)
  'zone', 'group', 'dimension', 'image', 'fp_text_box', 'property']);
/** A zone's lists the import makes something of (the rest kept: its settings). */
const ZONE_USED = new Set(['net', 'net_name', 'layer', 'layers', 'polygon', 'filled_polygon', 'keepout']);
/** A track's or arc's lists the import makes something of. */
const TRACK_USED = new Set(['start', 'mid', 'end', 'width', 'layer', 'net']);
/** A via's lists the import makes something of. */
const VIA_USED = new Set(['at', 'size', 'drill', 'layers', 'net']);
/** Lists whose uuid is always kept: groups and generated objects (tuning patterns). */
const GROUPS = new Set(['group', 'generated']);
/** Lists whose uuid the reader keeps as their `id` (the rest of a board's uuids aren't read): every object's, for the way back. */
const UUID_OF = new Set([...GROUPS, 'constraint', 'footprint', 'segment', 'arc', 'via', 'zone', 'dimension', 'target', 'image', 'pad', 'property',
  'gr_line', 'gr_arc', 'gr_circle', 'gr_rect', 'gr_poly', 'gr_curve', 'gr_text', 'gr_text_box', 'fp_line', 'fp_arc', 'fp_circle', 'fp_rect', 'fp_poly', 'fp_curve', 'fp_text', 'fp_text_box']);
/** The uuids a board's groups and generated objects name, to keep on their items (the rest are left out). */
export function groupMembers(text: string): Set<string> {
  const out = new Set<string>();
  for (let i = text.indexOf('(members'); i >= 0; i = text.indexOf('(members', i)) {
    i += 8;
    while (i < text.length && text.charCodeAt(i) !== 41) {
      const c = text.charCodeAt(i);
      if (c <= 32) { i++; continue; }
      const q = c === 34, j = q ? text.indexOf('"', i + 1) : i;
      let e = j;
      if (!q) while (e < text.length && text.charCodeAt(e) > 32 && text.charCodeAt(e) !== 41) e++;
      if (e < 0) return out;
      out.add(text.slice(q ? i + 1 : i, e));
      i = q ? e + 1 : e;
    }
  }
  return out;
}
/** A board read, its uuids left out but those its groups and generated objects need. */
export const parseBoard = (text: string): SList => parseSexpr(text, BOARD_SKIP, { keep: groupMembers(text), of: UUID_OF });

export interface BoardOptions {
  name: string; rules?: KicadRules;
  /** Net names as the imported schematics compile them, by KiCad's (so Update PCB finds nothing to change). */
  netNames?: Map<string, string>;
  /** The board already read. */
  tree?: SList;
}

export function convertBoard(text: string, opts: BoardOptions): BoardResult {
  const root = opts.tree ?? parseBoard(text);
  const warnings: string[] = [];
  // Copper layers in stack order
  const layerDefs = kids(root, 'layers')[0]?.items.filter(isList) ?? [];
  // Each (n "name" type ["user name"]): the number is the list's keyword
  const names = layerDefs.map((d) => str(d, 0) ?? '');
  const copper = names.filter((n) => /\.Cu$/.test(n)).sort((a, b) => (a === 'F.Cu' ? -1 : b === 'F.Cu' ? 1 : a === 'B.Cu' ? 1 : b === 'B.Cu' ? -1 : Number(/\d+/.exec(a)?.[0]) - Number(/\d+/.exec(b)?.[0])));
  const userName = new Map(layerDefs.map((d) => [str(d, 0) ?? '', str(d, 2) ?? '']));
  const layerOf = layerMap(copper);
  // Coordinates: KiCad's mm (Y down) → AD's units (Y up), the page's bottom-left 1000 mil from AD's origin
  const [, pageH] = ((): [number, number] => { const p = kid(root, 'paper'); const n = str(p) ?? 'A4'; const sz: Record<string, [number, number]> = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841], A: [279.4, 215.9], B: [431.8, 279.4], C: [558.8, 431.8], D: [863.6, 558.8], E: [1117.6, 863.6], USLetter: [279.4, 215.9], USLegal: [355.6, 215.9], USLedger: [431.8, 279.4] }; let s = n === 'User' ? [num(p, 1, 297), num(p, 2, 210)] as [number, number] : sz[n] ?? [297, 210]; if (flag(p, 'portrait')) s = [s[1], s[0]]; return s; })();
  const OX = mil(1000), OY = mil(1000) + mm(Math.max(pageH, 100));
  const ext = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const P = (p: Xy): Vec2 => {
    const v = { x: Math.round(OX + mm(p.x)), y: Math.round(OY - mm(p.y)) };
    if (v.x < ext.x0) ext.x0 = v.x; if (v.x > ext.x1) ext.x1 = v.x; if (v.y < ext.y0) ext.y0 = v.y; if (v.y > ext.y1) ext.y1 = v.y;
    return v;
  };
  const len = (v: number) => Math.round(mm(v));

  // Nets: KiCad's numbered table (to 9), else every name met
  const netIndex = new Map<string, number>();
  const netNames: string[] = [], kicadNames: string[] = [];
  const named = (name: string) => { netIndex.set(name, netNames.length); kicadNames.push(name); netNames.push(opts.netNames?.get(name) ?? name); };
  const netByNumber = new Map<number, string>();
  for (const n of kids(root, 'net')) { const name = str(n, 1) ?? ''; netByNumber.set(num(n, 0), name); }
  const netOf = (n: SList | undefined): number | undefined => {
    const l = kid(n, 'net');
    if (!l) return undefined;
    const first = str(l, 0);
    const name = str(l, 1) ?? (first !== undefined && /^\d+$/.test(first) ? netByNumber.get(Number(first)) : first);
    // KiCad's name for a lone pin's net: no net, as AD has it
    if (!name || /^unconnected-\(/.test(name)) return undefined;
    if (!netIndex.has(name)) named(name);
    return netIndex.get(name);
  };
  for (const name of netByNumber.values()) if (name && !/^unconnected-\(/.test(name) && !netIndex.has(name)) named(name);

  const comps: PropertyBag[] = [];
  const pads: PcbRawRecord[] = [], tracks: PcbRawRecord[] = [], arcs: PcbRawRecord[] = [], vias: PcbRawRecord[] = [], texts: PcbRawRecord[] = [], regions: PcbRawRecord[] = [], bodies: PcbRawRecord[] = [];
  const polygons: PropertyBag[] = [];
  const models = new Map<string, string>();   // model file name → its ID in ModelsNoEmbed
  const footprints = new Map<string, FootprintDef[]>();
  const fpSeen = new Set<string>();
  const outlineEdges: { a: Vec2; b: Vec2; arc?: { c: Vec2; r: number; sa: number; ea: number } }[] = [];

  /** A graphic item (gr_* / fp_*) on a layer: tracks, arcs, fills or regions; `place` maps its coordinates. */
  const graphic = (g: SList, place: (p: Xy) => Xy, component?: number, sink = { tracks, arcs, regions }) => {
    const layer = layerOf(val(g, 'layer') ?? '');
    if (layer === null) return;
    const w = Math.max(1, len(valNum(kid(g, 'stroke'), 'width', valNum(g, 'width', 0.1))));
    const filled = ['yes', 'solid'].includes(val(g, 'fill') ?? val(kid(g, 'fill'), 'type') ?? '');
    const net = netOf(g);
    const xyOf = (k: string): Vec2 => { const l = kid(g, k); return P(place({ x: num(l, 0), y: num(l, 1) })); };
    const kind = g.k.replace(/^(gr|fp)_/, '');
    const edge = layer === MECH(1);
    switch (kind) {
      case 'line': {
        const a = xyOf('start'), b = xyOf('end');
        sink.tracks.push(encodeTrack({ layer, a, b, width: w, component, net }));
        if (edge) outlineEdges.push({ a, b });
        break;
      }
      case 'arc': {
        const a = xyOf('start'), m = kid(g, 'mid') ? xyOf('mid') : null, b = xyOf('end');
        let arc = m ? arc3(a, m, b) : null;
        if (!m) {
          // KiCad 5 form: centre (start), arc start (end) and an angle
          const c = a, s0 = b, ang = valNum(g, 'angle');
          const r = Math.hypot(s0.x - c.x, s0.y - c.y), sa = (Math.atan2(s0.y - c.y, s0.x - c.x) * 180) / Math.PI;
          arc = { c, r: Math.round(r), start: ang < 0 ? sa + ang : sa, end: ang < 0 ? sa : sa - ang };
        }
        if (!arc) { sink.tracks.push(encodeTrack({ layer, a, b, width: w, component, net })); if (edge) outlineEdges.push({ a, b }); break; }
        sink.arcs.push(encodeArc({ layer, c: arc.c, r: arc.r, start: arc.start, end: arc.end, width: w, component, net }));
        if (edge) outlineEdges.push({ a, b, arc: { c: arc.c, r: arc.r, sa: arc.start, ea: arc.end } });
        break;
      }
      case 'circle': {
        const c = xyOf('center'), e = xyOf('end');
        const r = Math.round(Math.hypot(e.x - c.x, e.y - c.y));
        if (filled) sink.regions.push(encodeRegion({ layer, outline: Array.from({ length: 32 }, (_, i) => ({ x: Math.round(c.x + r * Math.cos((i / 32) * 2 * Math.PI)), y: Math.round(c.y + r * Math.sin((i / 32) * 2 * Math.PI)) })), component, net }));
        else sink.arcs.push(encodeArc({ layer, c, r, start: 0, end: 360, width: w, component, net }));
        if (edge) { const a = { x: c.x + r, y: c.y }, b = { x: c.x - r, y: c.y }; outlineEdges.push({ a, b, arc: { c, r, sa: 0, ea: 180 } }, { a: b, b: a, arc: { c, r, sa: 180, ea: 360 } }); }
        break;
      }
      case 'rect': {
        const s = kid(g, 'start'), e = kid(g, 'end');
        const x0 = num(s, 0), y0 = num(s, 1), x1 = num(e, 0), y1 = num(e, 1);
        const corners = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }].map((p) => P(place(p)));
        if (filled) sink.regions.push(encodeRegion({ layer, outline: corners, component, net }));
        for (let i = 0; i < 4; i++) { const a = corners[i]!, b = corners[(i + 1) % 4]!; if (!filled || w > 1) sink.tracks.push(encodeTrack({ layer, a, b, width: w, component, net })); if (edge) outlineEdges.push({ a, b }); }
        break;
      }
      case 'poly': {
        const list = flat(g, (p) => P(place(p)));
        if (list.length < 2) break;
        if (filled && list.length >= 3) sink.regions.push(encodeRegion({ layer, outline: list, component, net }));
        if (!filled || (w > mm(0.05) && layer !== L.TOP && layer !== L.BOTTOM)) for (let i = 0; i < list.length; i++) { const a = list[i]!, b = list[(i + 1) % list.length]!; if (i < list.length - 1 || list.length > 2) sink.tracks.push(encodeTrack({ layer, a, b, width: w, component, net })); }
        if (edge) for (let i = 0; i < list.length; i++) outlineEdges.push({ a: list[i]!, b: list[(i + 1) % list.length]! });
        break;
      }
      case 'curve': {
        // A Bézier as a polyline
        const c = pts(g).map((p) => P(place(p)));
        if (c.length !== 4) break;
        const at = (t: number) => ({ x: Math.round((1 - t) ** 3 * c[0]!.x + 3 * (1 - t) ** 2 * t * c[1]!.x + 3 * (1 - t) * t * t * c[2]!.x + t ** 3 * c[3]!.x), y: Math.round((1 - t) ** 3 * c[0]!.y + 3 * (1 - t) ** 2 * t * c[1]!.y + 3 * (1 - t) * t * t * c[2]!.y + t ** 3 * c[3]!.y) });
        for (let i = 0; i < 16; i++) { const a = at(i / 16), b = at((i + 1) / 16); sink.tracks.push(encodeTrack({ layer, a, b, width: w, component, net })); if (edge) outlineEdges.push({ a, b }); }
        break;
      }
    }
  };

  /** Text (gr_text, fp_text, a footprint's property) as AD stroke text, its anchor moved from KiCad's centre to AD's bottom-left. */
  const textOf = (t: SList, content: string, place: (p: Xy) => Xy, angleBase: number, component?: number, kindFlags: { isDesignator?: boolean; isComment?: boolean } = {}, keepUpright = false) => {
    const layer = layerOf(val(t, 'layer') ?? '');
    if (layer === null || !content) return;
    const e = kid(t, 'effects'), font = kid(e, 'font'), size = kid(font, 'size');
    const h = num(size, 0, 1), thick = valNum(font, 'thickness', h * 0.15);
    const js = kid(e, 'justify')?.items.map(String) ?? [];
    const mirrored = js.includes('mirror');
    const a = at(t);
    let angle = ((a.a + angleBase) % 360 + 360) % 360;
    let hj = js.includes('left') ? -1 : js.includes('right') ? 1 : 0, vj = js.includes('top') ? -1 : js.includes('bottom') ? 1 : 0;
    // Keep upright: turned half round about its box, the justification swapped
    if (keepUpright && !mirrored && angle > 90 && angle <= 270) { angle = (angle + 180) % 360; hj = -hj; vj = -vj; }
    // KiCad's anchor (the block's centre unless justified) → AD's per line: the line's bottom-left (mirrored: bottom-right)
    const lines = plainText(content).split('\n');
    const H = mm(h), pitch = H * 1.62, n = lines.length;
    const c = P(place({ x: a.x, y: a.y }));
    const r = (angle * Math.PI) / 180;
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      const w = strokeTextWidth(line, H);
      const hx = hj < 0 ? 0 : hj > 0 ? -w : -w / 2;
      const vy = vj < 0 ? -H - i * pitch : vj > 0 ? (n - 1 - i) * pitch : ((n - 1) * pitch) / 2 - i * pitch - H / 2;
      const ox = mirrored ? -hx : hx;
      const anchor = { x: Math.round(c.x + ox * Math.cos(r) - vy * Math.sin(r)), y: Math.round(c.y + ox * Math.sin(r) + vy * Math.cos(r)) };
      texts.push(encodeText({ layer, at: anchor, height: H, strokeWidth: Math.max(1, len(thick)), text: line, rotation: angle, mirrored, component, ...(i === 0 ? kindFlags : {}) }));
    });
  };
  const textContent = (s: string) => s.replace(/\$\{REFERENCE\}/g, '.Designator').replace(/\$\{VALUE\}/g, '.Comment').replace(/\$\{([A-Z_]+)\}/g, '.$1');

  // Each board graphic and text kept whole on what it makes, for the way back (kept.ts)
  let keptN = 0;
  const whole = (g: SList, make: () => void) => {
    const lists = [tracks, arcs, regions, texts], before = lists.map((l) => l.length);
    make();
    const made = lists.flatMap((l, i) => l.slice(before[i]));
    if (made.length) keepWhole(made, g, String(++keptN));
  };
  // Footprints' own items, one copy for each footprint of the same items (kept.ts: KEPT_STORAGE)
  const fpStore = new Map<string, string>();

  /* ── footprints ── */
  const fpDefs = kids(root, 'footprint').length ? kids(root, 'footprint') : kids(root, 'module');
  fpDefs.forEach((fp, ci) => {
    const id = str(fp) ?? '';
    const [libName, fpName] = id.includes(':') ? id.split(':', 2) as [string, string] : ['', id];
    const a = at(fp);
    const bottom = (val(fp, 'layer') ?? 'F.Cu') === 'B.Cu';
    const place = placer({ x: a.x, y: a.y }, a.a);
    const ref = str(prop(fp, 'Reference'), 1) ?? str(kids(fp, 'fp_text').find((t) => str(t) === 'reference'), 1) ?? '';
    const value = str(prop(fp, 'Value'), 1) ?? str(kids(fp, 'fp_text').find((t) => str(t) === 'value'), 1) ?? '';
    const refP = prop(fp, 'Reference') ?? kids(fp, 'fp_text').find((t) => str(t) === 'reference');
    const valP = prop(fp, 'Value') ?? kids(fp, 'fp_text').find((t) => str(t) === 'value');
    const hidden = (t?: SList) => !t || flag(t, 'hide') || flag(kid(t, 'effects'), 'hide');
    const onSilk = (t?: SList) => /SilkS/.test(val(t, 'layer') ?? '');
    const path = val(fp, 'path') ?? '';
    const attrs = kid(fp, 'attr')?.items.map(String) ?? [];
    const pos = P({ x: a.x, y: a.y });
    // Both keep a bottom footprint as its library's mirrored top to bottom, then turned: the same angle
    const adRot = ((a.a % 360) + 360) % 360;
    comps.push(PropertyBag.from({
      LAYER: bottom ? 'BOTTOM' : 'TOP', PATTERN: fpName, SOURCEDESIGNATOR: ref, SOURCEFOOTPRINTLIBRARY: `${libName || 'Footprints'}.PcbLib`, FOOTPRINTDESCRIPTION: val(fp, 'descr') ?? '',
      // KiCad's own ID for the way back (kicadLibId)
      ...(id ? { KICADFOOTPRINT: id } : {}),
      // Its uuid, its Footprint field's
      ...(fp.id ? { KICADUUID: fp.id } : {}), ...(prop(fp, 'Footprint')?.id ? { KICADFPFU: prop(fp, 'Footprint')!.id! } : {}),
      X: formatAltiumLength(pos.x), Y: formatAltiumLength(pos.y), ROTATION: altiumFloat(adRot), HEIGHT: '0mil',
      NAMEON: !hidden(refP) && onSilk(refP) ? 'TRUE' : 'FALSE', COMMENTON: !hidden(valP) && onSilk(valP) ? 'TRUE' : 'FALSE',
      SOURCEUNIQUEID: path ? `\\${uniqueIdFor(path)}` : '', LOCKED: flag(fp, 'locked') ? 'TRUE' : 'FALSE',
      // Board only: Graphical (Mechanical when in the BOM) [est]; not in the BOM: Standard (No BOM)
      COMPONENTKIND: attrs.includes('board_only') ? (attrs.includes('exclude_from_bom') ? 2 : 1) : attrs.includes('exclude_from_bom') ? 5 : 0,
      SOURCEDESCRIPTION: str(prop(fp, 'Description'), 1) ?? '', SOURCELIBREFERENCE: value,
    }));
    // Designator and comment texts, then the footprint's own texts
    if (refP) textOf(refP, ref, place, 0, ci, { isDesignator: true }, true);
    if (valP) textOf(valP, value, place, 0, ci, { isComment: true }, true);
    // The footprint's own graphics and texts kept whole, once for all its alike (kept.ts: keepFootprint)
    const own: SList[] = [];
    // (hidden ones too, which Konium shows nothing of; the fields the export writes itself aside)
    for (const t of kids(fp, 'fp_text')) {
      const kind = str(t) ?? '';
      if (kind === 'reference' || kind === 'value') continue;
      if (!hidden(t)) textOf(t, textContent(str(t, 1) ?? ''), place, 0, ci, {}, true);
      own.push(t);
    }
    for (const t of kids(fp, 'property')) {
      const k = str(t) ?? '';
      if (k === 'Reference' || k === 'Value' || k === 'Footprint' || k === 'Datasheet' || k === 'Description') continue;
      if (!hidden(t) && kid(t, 'layer')) textOf(t, textContent(str(t, 1) ?? ''), place, 0, ci, {}, true);
      own.push(t);
    }
    for (const g of fp.items) if (isList(g) && /^fp_(line|arc|circle|rect|poly|curve)$/.test(g.k)) { graphic(g, place, ci); own.push(g); }
    // (a text box, which Konium shows nothing of yet: with them, in the footprint's places as they are)
    own.push(...kids(fp, 'fp_text_box'));
    // (their uuids apart, in order: alike footprints' items one copy in the store)
    keepFootprint(comps[ci]!, own.map((x) => (x.id ? { k: x.k, items: x.items } : x)), { Reference: refP, Value: valP }, fpStore);
    if (own.some((x) => x.id)) comps[ci]!.set('KICADFPIDS', own.map((x) => x.id ?? '').join(','));
    // Its rule areas: the part's keep-outs; its dimensions, groups and other zones (in the board's places) kept with the part and where it was, for the way back
    kids(fp, 'zone').forEach((z, k) => { if (kid(z, 'keepout')) ruleArea(z, z.id ?? `fp${ci}zone${k + 1}`, ci); });
    const abs = fp.items.filter((x): x is SList => isList(x) && (x.k === 'dimension' || x.k === 'group' || (x.k === 'zone' && !kid(x, 'keepout'))));
    if (abs.length) { comps[ci]!.set('KICADFPABS', keepJson(abs)); comps[ci]!.set('KICADFPAT', `${a.x} ${a.y} ${a.a} ${bottom ? 'B' : 'F'}`); }
    // Its settings Konium makes nothing of (tags, its sheet, 3D models as KiCad names them, the datasheet, margins …), for the way back
    const fx = [...extrasOf(fp, FP_USED, 1).filter((x) => !(x.k === '' && (x.items[0] === 'locked' || x.items[0] === 'placed'))),
      ...kids(fp, 'property').filter((x) => str(x) === 'Datasheet' || str(x) === 'Description'), kid(fp, 'attr') ?? { k: 'attr', items: [] }];
    if (fx.length) comps[ci]!.set('KICADFPX', keepJson(fx));
    let apertures = 0;
    // Edge connector pads and through-hole pads on the outer copper only, for the way back: by
    // name and which of the footprint's pads of that name (#0 the first)
    const seen = new Map<string, number>();
    // Each pad's settings Konium makes nothing of (its pin's name and type, teardrops, its zone
    // connection, mask margin, drill offset …), by the same key, for the way back (KICADPADX)
    const padX: Record<string, SList[]> = {};
    const padU: [string, string][] = [];
    const marked = kids(fp, 'pad').map((pad) => {
      const name = str(pad) ?? '', k = seen.get(name) ?? 0;
      const m = emitPad(pad, place, ci, a.a, pads, regions, () => ++apertures);
      // A pad on no copper isn't a pad in Konium: it doesn't count
      if (m !== undefined) {
        seen.set(name, k + 1);
        const x = extrasOf(pad, PAD_USED, 3);
        // (a drill's offset, an exact corner ratio: the whole drill and ratio kept, written where they still hold)
        const off = kid(kid(pad, 'drill'), 'offset');
        if (off && (num(off, 0) || num(off, 1))) x.push(kid(pad, 'drill')!);
        if (kid(pad, 'roundrect_rratio')) x.push(kid(pad, 'roundrect_rratio')!);
        if (x.length) padX[`${name}#${k}`] = x;
        if (pad.id) padU.push([`${name}#${k}`, pad.id]);
      }
      return m ? { ...m, key: `${name}#${k}` } : null;
    }).filter((n) => n !== null);
    if (Object.keys(padX).length) comps[ci]!.set('KICADPADX', keepJson(padX));
    // (each pad's uuid, by the same key)
    if (padU.length) comps[ci]!.set('KICADPADU', keepJson(Object.fromEntries(padU)));
    for (const [k, list] of [['KICADCONNECT', marked.filter((m) => m.connect)], ['KICADFBCU', marked.filter((m) => m.fb)], ['KICADNOCU', marked.filter((m) => m.noCu)]] as const) {
      if (list.length) comps[ci]!.set(k, keepJson(list.map((m) => m.key)));
    }
    // The 3D model: linked by its STEP file's name
    for (const m of kids(fp, 'model')) {
      if (flag(m, 'hide')) continue;
      const file = (str(m) ?? '').split(/[\\/]/).pop()?.replace(/\.(wrl|wings|stp|step|igs|iges)$/i, '.step') ?? '';
      if (!file) continue;
      let mid = models.get(file.toLowerCase());
      if (!mid) { mid = guidOf(file.toLowerCase()); models.set(file.toLowerCase(), mid); }
      const off = kid(kid(m, 'offset') ?? kid(m, 'at'), 'xyz'), rot = kid(kid(m, 'rotate'), 'xyz');
      const o = place({ x: num(off, 0), y: bottom ? num(off, 1) : -num(off, 1) });
      const at2 = P(o);
      const box = courtyardBox(fp, place);
      bodies.push(encodeBody({ component: ci, outline: box.map(P), standoff: 0, overall: mm(1), colour: 0x808080, layer: bottom ? MECH(14) : MECH(13), bottom, at: at2, modelType: 1, id: guidOf(`${ref}|${file}`),
        extra: { MODELID: mid, 'MODEL.NAME': file, 'MODEL.EMBED': 'FALSE', 'MODEL.2D.ROTATION': '0.000', 'MODEL.3D.ROTX': (-num(rot, 0)).toFixed(3), 'MODEL.3D.ROTY': (-num(rot, 1)).toFixed(3),
          // KiCad turns the model (−X, −Y, −Z) then the footprint; AD's ROTZ holds both, underneath the board's turn the other way (as AD files have it)
          'MODEL.3D.ROTZ': ((((bottom ? -a.a : a.a) - num(rot, 2)) % 360 + 360) % 360).toFixed(3), 'MODEL.3D.DZ': formatAltiumLength(Math.round(mm(num(off, 2)))), 'MODEL.CHECKSUM': 0, 'MODEL.SNAPCOUNT': 0 } }));
    }
    // The footprint for the library: its items about its own origin, unturned
    const lib = libName || 'Footprints';
    if (!fpSeen.has(`${lib}:${fpName}`)) { fpSeen.add(`${lib}:${fpName}`); footprints.set(lib, [...(footprints.get(lib) ?? []), libraryFootprint(fp, fpName, layerOf)]); }
  });

  /**
   * A pad (and a custom pad's shapes as regions of its net marked as its shape: a polygon pad).
   * An edge connector pad (connect) is an SMD pad, and a through-hole pad on the outer copper
   * only (F&B.Cu) or on none one on all of it: what it was is returned for the component
   * (KICADCONNECT, KICADFBCU, KICADNOCU); a pad with no paste or no mask layer has none (a negative paste expansion, the
   * mask tented); a pad on no copper at all is the openings it makes, kept for the way back.
   */
  function emitPad(pad: SList, place: (p: Xy) => Xy, component: number | undefined, fpAngle: number, outPads: PcbRawRecord[], outRegions: PcbRawRecord[], aperture: () => number): { name: string; connect: boolean; fb: boolean; noCu: boolean } | null | undefined {
    const kind = String(pad.items[1] ?? 'smd'), shape = String(pad.items[2] ?? 'rect');
    const pa = at(pad);
    const size = kid(pad, 'size');
    let w = len(num(size, 0)), h = len(num(size, 1, num(size, 0)));
    const layers = kid(pad, 'layers')?.items.map(String) ?? [];
    const drill = kid(pad, 'drill');
    const oval = drill?.items.some((x) => String(x) === 'oval');
    const dvals = drill?.items.filter((x) => typeof x === 'number') as number[] | undefined;
    const thru = kind === 'thru_hole' || kind === 'np_thru_hole';
    const copper = thru || layers.some((l) => /^(\*|F|B|In\d+)\.Cu$/.test(l));
    const angle = ((pa.a % 360) + 360) % 360;
    const c = P(place({ x: pa.x, y: pa.y }));
    const net = netOf(pad);
    const options = kid(pad, 'options');
    const prims = shape === 'custom' ? (kid(pad, 'primitives')?.items.filter(isList) ?? []).map(primOf) : [];
    const to = padToBoard(c, angle);
    // A pad on no copper (a paste or mask opening alone): its openings, the pad kept whole
    if (!copper) {
      const id = String(aperture());
      const kept: ApertureKept = { ...(pad.id ? { id: pad.id } : {}), name: str(pad) ?? '', type: kind, shape, at: [pa.x, pa.y], angle: (((pa.a - fpAngle) % 360) + 360) % 360, size: [num(size, 0), num(size, 1, num(size, 0))], layers,
        ...(kid(pad, 'roundrect_rratio') ? { rratio: valNum(pad, 'roundrect_rratio', 0.25) } : {}),
        ...(options ? { anchor: val(options, 'anchor') ?? 'rect', clearance: val(options, 'clearance') ?? 'outline' } : {}),
        ...(shape === 'custom' ? { prims: prims.filter((x): x is Prim => !!x) } : {}), ...((): { x?: SList[] } => { const x = extrasOf(pad, PAD_USED, 3); return x.length ? { x } : {}; })() };
      const openings = layers.map((l) => ({ 'F.Paste': L.TOP_PASTE, 'B.Paste': L.BOTTOM_PASTE, 'F.Mask': L.TOP_SOLDER, 'B.Mask': L.BOTTOM_SOLDER } as Record<string, LayerId>)[l]).filter((l): l is LayerId => l !== undefined);
      const hw = mm(kept.size[0]) / 2, hh = mm(kept.size[1]) / 2;
      const ar = (angle * Math.PI) / 180;
      const corner = (x: number, y: number): Vec2 => ({ x: Math.round(c.x + x * Math.cos(ar) - y * Math.sin(ar)), y: Math.round(c.y + x * Math.sin(ar) + y * Math.cos(ar)) });
      const own = shape === 'circle' || shape === 'oval'
        ? [{ outline: Array.from({ length: 32 }, (_, i) => { const t = (i / 32) * 2 * Math.PI; return corner(Math.cos(t) * hw, Math.sin(t) * hh); }), holes: [] as Vec2[][] }]
        : [{ outline: [corner(-hw, -hh), corner(hw, -hh), corner(hw, hh), corner(-hw, hh)], holes: [] as Vec2[][] }];
      const shapes = shape === 'custom' ? (kept.prims ?? []).flatMap((q) => primShapes(q, to)) : own;
      const extra = { KICADAPERTURE: id, KICADPAD: keepJson(kept) };
      for (const l of openings) for (const sh of shapes) outRegions.push(encodeRegion({ layer: l, outline: sh.outline, holes: sh.holes, component, extra }));
      return undefined;
    }
    const layer: LayerId = thru || layers.includes('*.Cu') ? L.MULTI : layers.includes('B.Cu') ? L.BOTTOM : layers.includes('F.Cu') ? L.TOP : layerOf(layers.find((l) => /^In\d+\.Cu$/.test(l))!)!;
    let hole = 0, slot: { length: number; rotation: number } | undefined;
    if (dvals?.length) {
      const d0 = len(dvals[0]!), d1 = len(dvals[1] ?? dvals[0]!);
      hole = Math.min(d0, d1);
      if (oval && d0 !== d1) slot = { length: Math.max(d0, d1), rotation: d1 > d0 ? 90 : 0 };
    }
    if (kind === 'np_thru_hole' && (!w || layers.every((l) => !/Cu$/.test(l)))) { w = Math.max(w, hole); h = Math.max(h, hole); }
    const adShape = shape === 'circle' ? 'round' : shape === 'oval' ? 'round' : shape === 'roundrect' ? 'roundrect' : shape === 'custom' && val(options, 'anchor') === 'circle' ? 'round' : 'rect';
    const rr = valNum(pad, 'roundrect_rratio', 0.25);
    // Openings: an SMD pad's paste on its side, any pad's mask on each side it has one
    const outer = layer === L.MULTI || layer === L.TOP || layer === L.BOTTOM;
    const pasteAt = (side: string) => layers.includes(`${side}.Paste`) || layers.includes('*.Paste');
    const maskAt = (side: string) => layers.includes(`${side}.Mask`) || layers.includes('*.Mask');
    const noPaste = !thru && outer && !pasteAt(layer === L.BOTTOM ? 'B' : 'F');
    const rec = encodePad({ name: str(pad) ?? '', layer, at: c, w: Math.max(1, w), h: Math.max(1, h), shape: adShape as 'round', hole: hole || undefined, rotation: angle, net, component,
      cornerPct: adShape === 'roundrect' ? rr * 200 : undefined, slot, plated: kind === 'np_thru_hole' ? false : undefined, ...(noPaste ? { pasteExpansion: -Math.max(w, h) } : {}) });
    if (outer) {
      const s = rec.subs[4]!;
      const tent = (layer === L.BOTTOM ? 0 : maskAt('F') ? 0 : FLAG.tentTop) | (layer === L.TOP ? 0 : maskAt('B') ? 0 : FLAG.tentBottom);
      if (tent) put(s, PAD.flags1, (get(s, PAD.flags1) ?? 0) | tent);
    }
    outPads.push(rec);
    // Custom pads: their primitives as the pad's shape, copper of its net on its layers (each with
    // the primitive), its mask and paste openings as the pad has them
    if (shape === 'custom') {
      const name = str(pad) ?? '';
      const copperLayers: LayerId[] = layer === L.MULTI ? [L.TOP, L.BOTTOM] : [layer];
      const clearance = val(options, 'clearance') ?? 'outline';
      const all: { outline: Vec2[]; holes: Vec2[][] }[] = [];
      for (const q of prims) {
        if (!q) continue;
        for (const sh of primShapes(q, to)) {
          all.push(sh);
          for (const cl of copperLayers) outRegions.push(encodeRegion({ layer: cl, outline: sh.outline, holes: sh.holes, net, component, extra: { [PAD_SHAPE_KEY]: name, KICADPRIM: keepJson(q), KICADCLEARANCE: clearance } }));
        }
      }
      const openings: LayerId[] = [];
      if (layer !== L.BOTTOM && maskAt('F')) openings.push(L.TOP_SOLDER);
      if (layer !== L.TOP && maskAt('B')) openings.push(L.BOTTOM_SOLDER);
      if (!thru && !noPaste) openings.push(layer === L.BOTTOM ? L.BOTTOM_PASTE : L.TOP_PASTE);
      for (const ol of openings) {
        const grow = ol === L.TOP_SOLDER || ol === L.BOTTOM_SOLDER ? MASK_EXPANSION : 0;
        for (const sh of all) {
          const g = grownShape(sh, grow);
          if (g) outRegions.push(encodeRegion({ layer: ol, outline: g.outline, holes: g.holes, net, component, extra: { [PAD_SHAPE_KEY]: name } }));
        }
      }
    }
    const fb = layers.includes('F&B.Cu') && !layers.includes('*.Cu');
    // A hole with no copper at all (its mask only)
    const noCu = thru && !layers.some((l) => /Cu$/.test(l));
    return kind === 'connect' || fb || noCu ? { name: str(pad) ?? '', connect: kind === 'connect', fb, noCu } : null;
  }

  /* ── board items ── */
  const idPlace = (p: Xy) => p;
  for (const g of root.items) if (isList(g) && /^gr_(line|arc|circle|rect|poly|curve)$/.test(g.k)) whole(g, () => graphic(g, idPlace));
  // What Konium makes nothing of goes back as it was (Board6 KICADPASS): the title block, dimensions, hidden and empty texts
  const passed: SList[] = [];
  for (const t of kids(root, 'gr_text')) {
    if (!flag(t, 'hide') && !flag(kid(t, 'effects'), 'hide') && (str(t) ?? '').trim()) whole(t, () => textOf(t, textContent(str(t) ?? ''), idPlace, 0));
    else passed.push(t);
  }
  for (const n of root.items) if (isList(n) && (n.k === 'title_block' || n.k === 'dimension')) passed.push(n);
  let nTracks = 0, nVias = 0;
  for (const s of kids(root, 'segment')) {
    const layer = layerOf(val(s, 'layer') ?? '');
    if (layer === null) continue;
    const st = kid(s, 'start'), en = kid(s, 'end');
    tracks.push(encodeTrack({ layer, a: P({ x: num(st, 0), y: num(st, 1) }), b: P({ x: num(en, 0), y: num(en, 1) }), width: Math.max(1, len(valNum(s, 'width', 0.25))), net: netOf(s) }));
    // (its uuid; its settings Konium makes nothing of: locked …)
    const tx = extrasOf(s, TRACK_USED);
    if (s.id || tx.length) keepId(tracks[tracks.length - 1]!, s.id ?? '', tx.length ? keepJson(tx) : undefined);
    nTracks++;
  }
  for (const s of kids(root, 'arc')) {
    const layer = layerOf(val(s, 'layer') ?? '');
    if (layer === null) continue;
    const g = (k: string) => { const l = kid(s, k); return P({ x: num(l, 0), y: num(l, 1) }); };
    const arc = arc3(g('start'), g('mid'), g('end'));
    const width = Math.max(1, len(valNum(s, 'width', 0.25)));
    if (arc) arcs.push(encodeArc({ layer, c: arc.c, r: arc.r, start: arc.start, end: arc.end, width, net: netOf(s) }));
    else tracks.push(encodeTrack({ layer, a: g('start'), b: g('end'), width, net: netOf(s) }));
    const ax = extrasOf(s, TRACK_USED);
    if (s.id || ax.length) keepId(arc ? arcs[arcs.length - 1]! : tracks[tracks.length - 1]!, s.id ?? '', ax.length ? keepJson(ax) : undefined);
    nTracks++;
  }
  for (const v of kids(root, 'via')) {
    const ls = kid(v, 'layers')?.items.map(String) ?? ['F.Cu', 'B.Cu'];
    const span = ls.map((l) => layerOf(l)).filter((l): l is LayerId => l !== null);
    const stack = copper.map((c) => layerOf(c)!);
    const idx = span.map((l) => stack.indexOf(l)).filter((i) => i >= 0);
    const a = at(v);
    vias.push(encodeVia({ at: P(a), diameter: len(valNum(v, 'size', 0.6)), hole: len(valNum(v, 'drill', 0.3)), net: netOf(v),
      layerStart: idx.length ? stack[Math.min(...idx)] : L.TOP, layerEnd: idx.length ? stack[Math.max(...idx)] : L.BOTTOM }));
    // (its uuid; its settings Konium makes nothing of: free, which layers keep their ring, teardrops, blind)
    const vx = extrasOf(v, VIA_USED);
    if (v.id || vx.length) keepId(vias[vias.length - 1]!, v.id ?? '', vx.length ? keepJson(vx) : undefined);
    nVias++;
  }

  /** A rule area: keep-out regions on its layers (a footprint's: the part's), each keeping the rule area (its layers and what it keeps out) for the way back. */
  function ruleArea(z: SList, zid: string, component?: number): void {
    const keepout = kid(z, 'keepout')!;
    const zl = kid(z, 'layers')?.items.map(String) ?? [val(z, 'layer') ?? ''];
    const zLayers = zl.flatMap((n) => (n === '*.Cu' || n === 'F&B.Cu' ? copper : [n]));
    const outline = kids(z, 'polygon').map((p) => flattenVertices(ring(p, P)));
    const keep = { KICADZONE: zid, KICADZONELAYERS: zl.join(' '), KICADKEEPOUT: keepout.items.filter(isList).map((x) => `${x.k}=${String(x.items[0] ?? '')}`).join(','),
      // (its other settings: name, placement rules, hatching …)
      KICADZONEX: keepJson(extrasOf(z, ZONE_USED)) };
    for (const ln of zLayers) {
      const layer = layerOf(ln);
      if (layer === null) continue;
      for (const o of outline) if (o.length >= 3) { const rec = encodeRegion({ layer, outline: o, extra: keep, ...(component !== undefined ? { component } : {}) }); rec.subs[0]![2] = 2; regions.push(rec); }
    }
  }

  /* ── zones ── */
  let nPours = 0;
  const pourOrder: { index: number; prio: number }[] = [];
  let zoneN = 0;
  for (const z of kids(root, 'zone')) {
    // The zone's own ID for the way back (its uuid when the reader kept it, a group naming it, else its place among the zones)
    const zid = z.id ?? `zone${++zoneN}`;
    const zl = kid(z, 'layers')?.items.map(String) ?? [val(z, 'layer') ?? ''];
    const zLayers = zl.flatMap((n) => (n === '*.Cu' || n === 'F&B.Cu' ? copper : [n]));
    const rings = kids(z, 'polygon').map((p) => ring(p, P));
    const outline = rings.map((r) => flattenVertices(r));
    const net = netOf(z) ?? (val(z, 'net_name') ? netOf({ k: 'zone', items: [{ k: 'net', items: [0, val(z, 'net_name')!] }] }) : undefined);
    const keepout = kid(z, 'keepout');
    const teardrop = !!kid(kid(z, 'attr'), 'teardrop') || /^\$teardrop/.test(val(z, 'name') ?? '');
    const filled = kids(z, 'filled_polygon');
    if (keepout) { ruleArea(z, zid); continue; }
    if (teardrop) {
      // Copper regions, each keeping the teardrop's KiCad zone (type, outline in mm, priority) for the way back
      const keep: Record<string, string> = { KICADTEARDROP: val(kid(kid(z, 'attr'), 'teardrop'), 'type') ?? 'padvia', KICADZONE: zid, KICADPRIORITY: String(valNum(z, 'priority', 0)),
        KICADOUTLINE: (outline[0] ?? []).map((q) => `${Math.round(q.x)} ${Math.round(q.y)}`).join(';') };
      for (const f of filled) { const layer = layerOf(val(f, 'layer') ?? zLayers[0] ?? ''); const list = flat(f, P); if (layer !== null && list.length >= 3) regions.push(encodeRegion({ layer, outline: list, net, extra: keep })); }
      continue;
    }
    // The first outline is the zone's; others inside it are cut-outs, the rest more outlines of the zone
    const inside = (o: Vec2[]) => !!outline[0] && o.length > 0 && pointInPoly(o[0]!, outline[0]);
    const prio = valNum(z, 'priority', 0);
    for (const ln of zLayers) {
      const layer = layerOf(ln);
      if (layer === null || (layer !== L.TOP && layer !== L.BOTTOM && !(layer > L.TOP && layer < L.BOTTOM))) continue;
      rings.forEach((r, k) => {
        if (r.length < 3) return;
        if (k > 0 && inside(outline[k]!)) { regions.push(encodeRegion({ layer, outline: outline[k]!, kind: 1 })); return; }
        const index = polygons.length;
        const base = val(z, 'name') || `${netNames[net ?? -1] ?? 'NoNet'}_${ln.replace('.', '_')}`;
        const bag = newPolygonProps(layerToName(layer), net ?? 0xffff, `${base}_P${String(index).padStart(3, '0')}`, index);
        writeVertices(bag, r);
        // An outline of arcs as KiCad wrote it (pts of arcs), for the way back while the pour's outline is as read
        if (rings.length === 1 && zLayers.length === 1 && kids(kid(kids(z, 'polygon')[0], 'pts'), 'arc').length) { bag.set('KICADZONEPOLY', keepJson(kids(z, 'polygon'))); bag.set('KICADZONEPSIG', vertexSig(bag)); }
        // A zone on several layers: a pour per layer, each keeping the zone (its ID and layers) for the way back
        if (zLayers.length > 1) { bag.set('KICADZONE', zid); bag.set('KICADZONELAYERS', zl.join(' ')); }
        if (z.id) bag.set('KICADUUID', z.id);
        // The zone's settings as KiCad had them (its name or none, priority, pad connection, minimum width, fill and thermal
        // settings …), for the way back while the pour's own are as the import set them (zoneSig, after the pour order)
        bag.set('KICADZONEX', keepJson(extrasOf(z, ZONE_USED)));
        if (val(kid(z, 'fill'), 'mode') === 'hatch') {
          bag.set('HATCHSTYLE', '90Degree');
          const hw = valNum(kid(z, 'fill'), 'hatch_thickness', 0), hg = valNum(kid(z, 'fill'), 'hatch_gap', 0);
          if (hw) bag.set('TRACKWIDTH', formatAltiumLength(len(hw)));
          if (hg) bag.set('GRIDSIZE', formatAltiumLength(len(hg + hw)));
        }
        polygons.push(bag);
        pourOrder.push({ index, prio });
        // KiCad's fill as the pour's copper (a repour gives Konium's own)
        if (k === 0) for (const f of filled) {
          if ((val(f, 'layer') ?? ln) !== ln) continue;
          const list = flat(f, P);
          if (list.length >= 3) regions.push(encodeRegion({ layer, outline: list, net, polygon: index }));
        }
        nPours++;
      });
    }
  }
  // Pour order: KiCad's higher priority first, then as written
  pourOrder.sort((a, b) => b.prio - a.prio || a.index - b.index).forEach((o, i) => polygons[o.index]!.set('POURINDEX', String(i)));
  for (const b of polygons) if (b.has('KICADZONEX')) b.set('KICADZONESIG', zoneSig(b));

  /* ── the board shape ── */
  const loops = chainLoops(outlineEdges);
  let vertices: PolyVertex[];
  if (loops.length) {
    const area = (vs: PolyVertex[]) => Math.abs(vs.reduce((s, v, i) => { const n = vs[(i + 1) % vs.length]!.p; return s + v.p.x * n.y - n.x * v.p.y; }, 0));
    loops.sort((a, b) => area(b) - area(a));
    vertices = loops[0]!;
    for (const cut of loops.slice(1)) regions.push(encodeRegion({ layer: L.MULTI, outline: flattenVertices(cut), boardCutout: true }));
  } else {
    // No Edge.Cuts: round everything
    warnings.push('No Edge.Cuts outline: the board shape is drawn round its contents');
    const m = mm(2);
    const [x0, y0, x1, y1] = Number.isFinite(ext.x0) ? [ext.x0 - m, ext.y0 - m, ext.x1 + m, ext.y1 + m] : [OX, OY - mm(80), OX + mm(100), OY];
    vertices = [{ p: { x: x0, y: y0 } }, { p: { x: x1, y: y0 } }, { p: { x: x1, y: y1 } }, { p: { x: x0, y: y1 } }];
  }
  const aux = kid(kid(root, 'setup'), 'aux_axis_origin');
  const xs = vertices.map((v) => v.p.x), ys = vertices.map((v) => v.p.y);
  const origin = aux && (num(aux, 0) || num(aux, 1)) ? P({ x: num(aux, 0), y: num(aux, 1) }) : { x: Math.min(...xs), y: Math.min(...ys) };
  const board = newBoardRecord({ fileName: opts.name, origin, outline: vertices, sheet: { x: 0, y: 0, width: Math.round(mm(Math.max(pageH * 1.42, 297)) + mil(2000)), height: Math.round(mm(pageH) + mil(2000)) },
    mechanical: [1, 2, 3, 13, 15] });
  // KiCad's layers as this import maps them, for the way back (exportPcb: Mechanical 1 Edge.Cuts again)
  board.set('KICADLAYERS', 'TRUE');
  // Their types as the desktop software names them, and its component layer pairs: Fab as Assembly, CrtYd as Courtyard, the Adhes pair
  // (a footprint flipped in Konium takes its Fab, courtyard and glue drawings to the other side, as KiCad does)
  writeMechLayout(board, new Map([[MECH(1), 'BoardShape'], [MECH(13), 'AssemblyTop'], [MECH(14), 'AssemblyBottom'], [MECH(15), 'CourtyardTop'], [MECH(16), 'CourtyardBottom']]),
    [[MECH(13), MECH(14)], [MECH(15), MECH(16)], [MECH(9), MECH(10)]]);
  // Where KiCad's millimetres were put, for its graphics kept whole (kept.ts)
  board.set('KICADORIGIN', `${OX},${OY}`);
  if (passed.length) board.set('KICADPASS', keepJson(passed));
  // Groups and generated objects (tuning patterns), for the way back: written again with the items they name that are there (exportPcb)
  const grouped = root.items.filter((n): n is SList => isList(n) && GROUPS.has(n.k)).map((n) => (n.id || n.k !== 'group' ? n : { ...n, id: val(n, 'id') }));
  if (grouped.length) board.set('KICADGROUPS', keepJson(grouped));
  // A newer KiCad's geometric constraints between objects (by their uuids), for the way back while those objects are
  const constraints = kids(root, 'constraint');
  if (constraints.length) board.set('KICADCONSTRAINTS', keepJson(constraints));

  /* ── the file ── */
  const { rules, classes } = boardRules(opts.rules, kicadNames, netNames);
  // Every net keeps KiCad's name, and the one it was given for the schematics' compile, for the way back (kicadNetKeys)
  const netKeys = kicadNames.map((k, i) => kicadNetKeys(k, netNames[i]!));
  const doc = assemblePcbDoc({ board, nets: netNames, netKeys, comps, polygons, pads, tracks, vias, arcs, texts, regions, bodies, models, rules, classes }, opts.name);
  // Each footprint's kept items, once for its alike, and told by where its own things are in the part (now the parts are placed)
  writeFootprintStore(doc, fpStore);
  sealFootprints(doc);
  // The layer stack: KiCad's copper and stack-up
  applyStack(doc, root, copper, userName);
  return { bytes: writePcbDoc(doc), warnings, footprints, stats: { components: comps.length, tracks: nTracks, vias: nVias, pours: nPours } };
}

/**
 * The board's nets named as compiled schematics name them: each KiCad net takes the name of the
 * compiled net most of its pads are on (each name once; a name another net keeps stays its).
 */
export function netNamesFrom(root: SList, nets: { name: string; pins: { designator: string; pin: string }[] }[]): Map<string, string> {
  const pinNet = new Map<string, string>();
  for (const n of nets) for (const p of n.pins) pinNet.set(`${p.designator}\u0000${p.pin}`, n.name);
  const numbered = new Map(kids(root, 'net').map((n) => [str(n, 0) ?? '', str(n, 1) ?? '']));
  const votes = new Map<string, Map<string, number>>();
  for (const fp of kids(root, 'footprint')) {
    const ref = str(prop(fp, 'Reference'), 1) ?? str(kids(fp, 'fp_text').find((t) => str(t) === 'reference'), 1) ?? '';
    for (const pad of kids(fp, 'pad')) {
      const l = kid(pad, 'net');
      if (!l) continue;
      const k = str(l, 1) ?? (/^\d+$/.test(str(l, 0) ?? '') ? numbered.get(str(l, 0)!) : str(l, 0)) ?? '';
      const ad = pinNet.get(`${ref}\u0000${str(pad) ?? ''}`);
      if (!k || !ad) continue;
      if (!votes.has(k)) votes.set(k, new Map());
      votes.get(k)!.set(ad, (votes.get(k)!.get(ad) ?? 0) + 1);
    }
  }
  const pairs = [...votes].flatMap(([k, m]) => [...m].map(([ad, n]) => ({ k, ad, n }))).sort((a, b) => b.n - a.n);
  const out = new Map<string, string>(), taken = new Set<string>();
  for (const { k, ad } of pairs) if (!out.has(k) && !taken.has(ad)) { out.set(k, ad); taken.add(ad); }
  // A name an unrenamed net keeps isn't given to another
  const kept = new Set([...numbered.values(), ...votes.keys()].filter((k) => !out.has(k)));
  for (const [k, ad] of [...out]) if (k === ad || kept.has(ad)) out.delete(k);
  return out;
}

/** The courtyard's box (or the pads' and graphics' box) in KiCad's board coordinates. */
function courtyardBox(fp: SList, place: (p: Xy) => Xy): Xy[] {
  const local: Xy[] = [];
  for (const g of fp.items) {
    if (!isList(g) || !/^fp_/.test(g.k) || !/CrtYd/.test(val(g, 'layer') ?? '')) continue;
    for (const k of ['start', 'end', 'center', 'mid']) { const l = kid(g, k); if (l) local.push({ x: num(l, 0), y: num(l, 1) }); }
    local.push(...pts(g));
  }
  if (!local.length) for (const p of kids(fp, 'pad')) { const a = at(p), s = kid(p, 'size'); local.push({ x: a.x - num(s, 0) / 2, y: a.y - num(s, 1) / 2 }, { x: a.x + num(s, 0) / 2, y: a.y + num(s, 1) / 2 }); }
  if (!local.length) local.push({ x: -0.5, y: -0.5 }, { x: 0.5, y: 0.5 });
  const x0 = Math.min(...local.map((p) => p.x)), x1 = Math.max(...local.map((p) => p.x)), y0 = Math.min(...local.map((p) => p.y)), y1 = Math.max(...local.map((p) => p.y));
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }].map(place);
}

/** Edge.Cuts pieces joined end to end into closed loops (ends within `tol`, 10 µm). */
export function chainLoops(edges: { a: Vec2; b: Vec2; arc?: { c: Vec2; r: number; sa: number; ea: number } }[], tol = mm(0.01)): PolyVertex[][] {
  const TOL = tol;
  const near = (p: Vec2, q: Vec2) => Math.abs(p.x - q.x) <= TOL && Math.abs(p.y - q.y) <= TOL;
  const used = new Set<number>();
  const out: PolyVertex[][] = [];
  for (let i = 0; i < edges.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const loop: PolyVertex[] = [];
    let cur = edges[i]!, from = cur.a;
    const start = from;
    for (let guard = 0; guard < edges.length + 1; guard++) {
      const to = near(cur.a, from) ? cur.b : cur.a;
      loop.push({ p: from, arc: cur.arc });
      if (near(to, start)) { out.push(loop); break; }
      const next = edges.findIndex((e, k) => !used.has(k) && (near(e.a, to) || near(e.b, to)));
      if (next < 0) break;
      used.add(next);
      cur = edges[next]!; from = to;
    }
  }
  return out.filter((l) => l.length >= 2);
}


/** KiCad's design rules and net classes (from the project) as AD's rules and net classes. */
export function boardRules(k: KicadRules | undefined, nets: string[], adNames: string[]): { rules: PcbRule[]; classes: PropertyBag[] } {
  const rules = newBoardRules();
  const rule = (kind: string) => rules.find((r) => r.bag.get('RULEKIND') === kind);
  const mmS = (v: number) => `${Math.round(v * 10000) / 10000}mm`;
  if (k?.clearance !== undefined) for (const key of ['GAP', 'GENERICCLEARANCE']) rule('Clearance')?.bag.set(key, mmS(k.clearance));
  const width = rule('Width');
  if (width && k?.trackWidth !== undefined) { width.bag.set('MINLIMIT', mmS(k.minTrack ?? Math.min(0.127, k.trackWidth))); width.bag.set('PREFEREDWIDTH', mmS(k.trackWidth)); width.bag.set('MAXLIMIT', mmS(Math.max(k.trackWidth * 4, 2))); }
  const via = rule('RoutingVias');
  if (via && k?.viaDiameter !== undefined && k.viaDrill !== undefined) {
    via.bag.set('MINWIDTH', mmS(k.minVia ?? k.viaDiameter)); via.bag.set('WIDTH', mmS(k.viaDiameter)); via.bag.set('MAXWIDTH', mmS(Math.max(k.viaDiameter, 1)));
    via.bag.set('MINHOLEWIDTH', mmS(k.minDrill ?? k.viaDrill)); via.bag.set('HOLEWIDTH', mmS(k.viaDrill)); via.bag.set('MAXHOLEWIDTH', mmS(Math.max(k.viaDrill, 0.6)));
  }
  if (k?.holeToHole !== undefined) rule('HoleToHoleClearance')?.bag.set('GAP', mmS(k.holeToHole));
  rule('HoleSize')?.bag.set('MAXLIMIT', '6.35mm');
  const classes: PropertyBag[] = newBoardClasses();
  let prio = 1;
  for (const c of k?.classes ?? []) {
    const res = (c.patterns ?? []).map((p) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`));
    const members = nets.flatMap((n, i) => (c.nets.includes(n) || res.some((r) => r.test(n)) ? [adNames[i]!] : []));
    if (!members.length || c.name === 'Default') continue;
    classes.push(PropertyBag.fromEntries([['SELECTION', 'FALSE'], ['LAYER', 'MULTILAYER'], ['LOCKED', 'FALSE'], ['POLYGONOUTLINE', 'FALSE'], ['USERROUTED', 'TRUE'], ['KEEPOUT', 'FALSE'], ['UNIONINDEX', '0'],
      ['NAME', c.name], ['KIND', '0'], ['SUPERCLASS', 'FALSE'], ...members.map((m, i): [string, string] => [`M${i}`, m]), ['SELECTED', 'FALSE'], ['UNIQUEID', uniqueIdFor(`class:${c.name}`)]]));
    const scope = `InNetClass('${c.name}')`;
    if (c.trackWidth !== undefined) {
      const r = newRule('Width', `Width_${c.name}`, prio);
      r.bag.set('SCOPE1EXPRESSION', scope); r.bag.set('MINLIMIT', mmS(Math.min(c.trackWidth, k?.minTrack ?? c.trackWidth))); r.bag.set('PREFEREDWIDTH', mmS(c.trackWidth)); r.bag.set('MAXLIMIT', mmS(Math.max(c.trackWidth * 4, 2)));
      rules.push(r);
    }
    if (c.clearance !== undefined && c.clearance !== k?.clearance) {
      const r = newRule('Clearance', `Clearance_${c.name}`, prio);
      r.bag.set('SCOPE1EXPRESSION', scope); r.bag.set('GAP', mmS(c.clearance));
      rules.push(r);
    }
    if (c.viaDiameter !== undefined && c.viaDrill !== undefined && (c.viaDiameter !== k?.viaDiameter || c.viaDrill !== k?.viaDrill)) {
      const r = newRule('RoutingVias', `RoutingVias_${c.name}`, prio);
      r.bag.set('SCOPE1EXPRESSION', scope);
      for (const [key, v] of [['MINWIDTH', c.viaDiameter], ['WIDTH', c.viaDiameter], ['MAXWIDTH', c.viaDiameter], ['MINHOLEWIDTH', c.viaDrill], ['HOLEWIDTH', c.viaDrill], ['MAXHOLEWIDTH', c.viaDrill]] as const) r.bag.set(key, mmS(v));
      rules.push(r);
    }
    prio++;
  }
  // Defaults rank after the class rules
  for (const r of rules) if (!/_/.test(r.bag.get('NAME') ?? '') && rules.some((x) => x !== r && x.bag.get('RULEKIND') === r.bag.get('RULEKIND') && /_/.test(x.bag.get('NAME') ?? ''))) r.bag.set('PRIORITY', String(prio));
  return { rules, classes };
}

/** The board's stack: its inner copper layers added, KiCad's thicknesses, materials and layer names. */
function applyStack(doc: PcbDocument, root: SList, copper: string[], userName: Map<string, string>): void {
  const su = kids(kid(kid(root, 'setup'), 'stackup'), 'layer');
  const cu = su.filter((l) => val(l, 'type') === 'copper');
  const diel = su.filter((l) => /core|prepreg/i.test(val(l, 'type') ?? ''));
  const total = valNum(kid(root, 'general'), 'thickness', 1.6);
  const fallbackDiel = (total - copper.length * 0.035) / Math.max(1, copper.length - 1);
  applyStackLayers(doc,
    copper.map((nm, i) => ({ name: userName.get(nm) || nm, thickness: mm(cu[i] ? valNum(cu[i], 'thickness', 0.035) : 0.035) })),
    Array.from({ length: Math.max(0, copper.length - 1) }, (_, i) => {
      const k = diel[i];
      return { thickness: mm(k ? valNum(k, 'thickness', fallbackDiel) : fallbackDiel), material: val(k, 'material') ?? 'FR-4', er: valNum(k, 'epsilon_r', 4.5), prepreg: /prepreg/i.test(val(k, 'type') ?? 'core') };
    }));
}

/* ── footprints as a library ── */

/**
 * A footprint (as placed on a board, or from a .kicad_mod) about its own origin: the records of a
 * PcbLib footprint. One placed on the bottom is stored flipped (its Y and its layers' sides):
 * flipped back. Pads' angles on a board carry the footprint's turn: taken off.
 */
function libraryFootprint(fp: SList, name: string, layerOf: (n: string) => LayerId | null): FootprintDef {
  const recs: PcbRawRecord[] = [];
  const a = at(fp);
  const flipped = val(fp, 'layer') === 'B.Cu';
  const P = (p: Xy): Vec2 => ({ x: Math.round(mm(p.x)), y: Math.round(flipped ? mm(p.y) : -mm(p.y)) });
  const side = (n: string) => (flipped ? n.replace(/^([FB])\./, (_, s: string) => (s === 'F' ? 'B.' : 'F.')) : n);
  const relAngle = (v: number) => ((((flipped ? -(v - a.a) : v - a.a) % 360) + 360) % 360);
  const lay = (g: SList) => layerOf(side(val(g, 'layer') ?? ''));
  for (const g of fp.items) {
    if (!isList(g)) continue;
    const layer = lay(g);
    const w = Math.max(1, Math.round(mm(valNum(kid(g, 'stroke'), 'width', valNum(g, 'width', 0.1)))));
    const filled = ['yes', 'solid'].includes(val(g, 'fill') ?? val(kid(g, 'fill'), 'type') ?? '');
    const xy = (k: string) => { const l = kid(g, k); return P({ x: num(l, 0), y: num(l, 1) }); };
    if (layer !== null && g.k === 'fp_line') recs.push(encodeTrack({ layer, a: xy('start'), b: xy('end'), width: w }));
    else if (layer !== null && g.k === 'fp_arc' && kid(g, 'mid')) { const c = arc3(xy('start'), xy('mid'), xy('end')); if (c) recs.push(encodeArc({ layer, c: c.c, r: c.r, start: c.start, end: c.end, width: w })); }
    else if (layer !== null && g.k === 'fp_circle') { const c = xy('center'), e = xy('end'); recs.push(encodeArc({ layer, c, r: Math.round(Math.hypot(e.x - c.x, e.y - c.y)), start: 0, end: 360, width: w })); }
    else if (layer !== null && g.k === 'fp_rect') {
      const s = kid(g, 'start'), e = kid(g, 'end');
      const c = [[num(s, 0), num(s, 1)], [num(e, 0), num(s, 1)], [num(e, 0), num(e, 1)], [num(s, 0), num(e, 1)]].map(([x, y]) => P({ x: x!, y: y! }));
      if (filled) recs.push(encodeRegion({ layer, outline: c }));
      else for (let i = 0; i < 4; i++) recs.push(encodeTrack({ layer, a: c[i]!, b: c[(i + 1) % 4]!, width: w }));
    } else if (layer !== null && g.k === 'fp_poly') {
      const list = flat(g, P);
      if (filled && list.length >= 3) recs.push(encodeRegion({ layer, outline: list }));
      else for (let i = 0; i + 1 < list.length; i++) recs.push(encodeTrack({ layer, a: list[i]!, b: list[i + 1]!, width: w }));
    } else if (g.k === 'pad') {
      const kind = String(g.items[1] ?? 'smd'), shape = String(g.items[2] ?? 'rect');
      const pa = at(g), size = kid(g, 'size');
      const layers = (kid(g, 'layers')?.items.map(String) ?? []).map(side);
      const drill = kid(g, 'drill');
      const dv = drill?.items.filter((x) => typeof x === 'number') as number[] | undefined;
      const hole = dv?.length ? Math.round(mm(Math.min(dv[0]!, dv[1] ?? dv[0]!))) : 0;
      const oval = drill?.items.some((x) => String(x) === 'oval') && dv && dv.length > 1 && dv[0] !== dv[1];
      const thru = kind === 'thru_hole' || kind === 'np_thru_hole';
      const rot = relAngle(pa.a);
      const c = P(pa);
      const to = padToBoard(c, rot);
      const prims = shape === 'custom' ? (kid(g, 'primitives')?.items.filter(isList) ?? []).map(primOf).filter((x): x is Prim => !!x) : [];
      // A pad on no copper: the openings it makes (as on a board)
      if (!thru && !layers.some((l) => /^(\*|F|B|In\d+)\.Cu$/.test(l))) {
        const hw = mm(num(size, 0)) / 2, hh = mm(num(size, 1, num(size, 0))) / 2, ar = (rot * Math.PI) / 180;
        const corner = (x: number, y: number): Vec2 => ({ x: Math.round(c.x + x * Math.cos(ar) - y * Math.sin(ar)), y: Math.round(c.y + x * Math.sin(ar) + y * Math.cos(ar)) });
        const shapes = shape === 'custom' ? prims.flatMap((q) => primShapes(q, to))
          : shape === 'circle' || shape === 'oval' ? [{ outline: Array.from({ length: 32 }, (_, i) => { const t = (i / 32) * 2 * Math.PI; return corner(Math.cos(t) * hw, Math.sin(t) * hh); }), holes: [] as Vec2[][] }]
          : [{ outline: [corner(-hw, -hh), corner(hw, -hh), corner(hw, hh), corner(-hw, hh)], holes: [] as Vec2[][] }];
        for (const l of layers.map((x) => ({ 'F.Paste': L.TOP_PASTE, 'B.Paste': L.BOTTOM_PASTE, 'F.Mask': L.TOP_SOLDER, 'B.Mask': L.BOTTOM_SOLDER } as Record<string, LayerId>)[x]).filter((x): x is LayerId => x !== undefined)) {
          for (const sh of shapes) recs.push(encodeRegion({ layer: l, outline: sh.outline, holes: sh.holes }));
        }
        continue;
      }
      const pl: LayerId = thru || layers.includes('*.Cu') ? L.MULTI : layers.includes('B.Cu') ? L.BOTTOM : L.TOP;
      const adShape = shape === 'circle' || shape === 'oval' ? 'round' : shape === 'roundrect' ? 'roundrect' : shape === 'custom' && val(kid(g, 'options'), 'anchor') === 'circle' ? 'round' : 'rect';
      let w2 = Math.round(mm(num(size, 0))), h2 = Math.round(mm(num(size, 1, num(size, 0))));
      if (kind === 'np_thru_hole') { w2 = Math.max(w2, hole); h2 = Math.max(h2, hole); }
      const maskAt = (sd: string) => layers.includes(`${sd}.Mask`) || layers.includes('*.Mask');
      const noPaste = !thru && !layers.includes(pl === L.BOTTOM ? 'B.Paste' : 'F.Paste') && !layers.includes('*.Paste');
      const rec = encodePad({ name: str(g) ?? '', layer: pl, at: c, w: Math.max(1, w2), h: Math.max(1, h2), shape: adShape as 'round', hole: hole || undefined, rotation: rot,
        cornerPct: adShape === 'roundrect' ? valNum(g, 'roundrect_rratio', 0.25) * 200 : undefined, slot: oval ? { length: Math.round(mm(Math.max(dv![0]!, dv![1]!))), rotation: dv![1]! > dv![0]! ? 90 : 0 } : undefined,
        plated: kind === 'np_thru_hole' ? false : undefined, ...(noPaste ? { pasteExpansion: -Math.max(w2, h2) } : {}) });
      const tent = (pl === L.BOTTOM || maskAt('F') ? 0 : FLAG.tentTop) | (pl === L.TOP || maskAt('B') ? 0 : FLAG.tentBottom);
      if (tent) put(rec.subs[4]!, PAD.flags1, (get(rec.subs[4]!, PAD.flags1) ?? 0) | tent);
      recs.push(rec);
      // A custom pad's shapes: regions marked as its shape (a polygon pad), with its openings
      if (shape === 'custom') {
        const name = str(g) ?? '';
        const all = prims.flatMap((q) => primShapes(q, to));
        for (const cl of pl === L.MULTI ? [L.TOP, L.BOTTOM] : [pl]) for (const sh of all) recs.push(encodeRegion({ layer: cl, outline: sh.outline, holes: sh.holes, extra: { [PAD_SHAPE_KEY]: name } }));
        const openings: LayerId[] = [];
        if (pl !== L.BOTTOM && maskAt('F')) openings.push(L.TOP_SOLDER);
        if (pl !== L.TOP && maskAt('B')) openings.push(L.BOTTOM_SOLDER);
        if (!thru && !noPaste) openings.push(pl === L.BOTTOM ? L.BOTTOM_PASTE : L.TOP_PASTE);
        for (const ol of openings) for (const sh of all) {
          const gs = grownShape(sh, ol === L.TOP_SOLDER || ol === L.BOTTOM_SOLDER ? MASK_EXPANSION : 0);
          if (gs) recs.push(encodeRegion({ layer: ol, outline: gs.outline, holes: gs.holes, extra: { [PAD_SHAPE_KEY]: name } }));
        }
      }
    }
  }
  return { name, description: val(fp, 'descr') ?? '', height: '0mil', records: recs };
}

/** A .pretty folder's .kicad_mod files as one AD PcbLib. */
export function convertFootprintLibrary(files: { name: string; text: string }[], libName: string): { bytes: Uint8Array; count: number } {
  const layerOf = layerMap(['F.Cu', 'B.Cu']);
  const defs: FootprintDef[] = [];
  for (const f of files) {
    const fp = parseSexpr(f.text);
    const name = (str(fp) ?? f.name.replace(/\.kicad_mod$/i, '')).split(':').pop()!;
    // (KiCad's footprint as it was, for the way back while the footprint is what the import made: KICADSIG, below)
    defs.push({ ...libraryFootprint(fp, name, layerOf), params: { KICADSRC: keepJson(fp) } });
  }
  // Each footprint's primitives as the library holds them, read back: their fingerprint
  const back = readPcbLib(writePcbLib(defs, `${libName}.PcbLib`), `${libName}.PcbLib`);
  const sigs = new Map(back.footprints.map((f) => [f.name, libFootprintSig(f.prims)]));
  for (const d of defs) { const sg = sigs.get(d.name); if (sg) d.params = { ...d.params, KICADSIG: sg }; }
  return { bytes: writePcbLib(defs, `${libName}.PcbLib`), count: defs.length };
}

/** Footprints as a PcbLib (A–Z). */
export const footprintLibrary = (fps: FootprintDef[], name: string): Uint8Array => writePcbLib([...fps].sort((a, b) => a.name.localeCompare(b.name)), name);

export { defaultStack };
