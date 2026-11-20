/**
 * EAGLE boards as AD's: the copper layers (the active ones of 1–16, in order), the board shape
 * from the Dimension layer's loops (the largest the board, the others and Milling's closed loops
 * cut-outs), the elements as components placed as EAGLE turns and mirrors them (a mirrored one on
 * the bottom, its layers swapped), their pads as the board's design rules make them (through-hole
 * diameters from the restring rules where the library leaves them to the rules or asks less, the
 * top, inner and bottom layers' sizes apart where they differ, the pad shape rules, long and offset
 * pads, SMD roundness, mask and cream frames, stop and cream off, a Milling slot in a pad as its
 * slotted hole), holes, the signals' tracks and arcs, vias (blind and buried by their extent),
 * polygons as polygon pours (solid or hatched, their width, isolation, orphans, thermals and rank;
 * cut-out polygons as polygon cut-outs) poured by the rules, the restrict layers as keep-outs, the
 * texts (smashed names and values where the element shows them, EAGLE's readable-text rule), the
 * other layers on mechanical layers named after them; the net classes, and the design rules as AD's
 * (clearance, widths, via and hole sizes, mask and paste expansions, thermal gap). EAGLE's
 * millimetres, Y up, are AD's; AD's origin is EAGLE's.
 */
import * as ClipperNS from 'clipper-lib';
import type { Vec2 } from '../../core/geom';
import { formatAltiumLength, mil, mm, UNITS_PER_MM } from '../../core/units';
import { L, mechLayer, type LayerId } from '../../model/layers';
import type { PcbPolygon, PolyVertex } from '../../model/pcb';
import { footprintsFromBoard } from '../../model/pcbLib';
import { repour } from '../../model/pcbEdit';
import { resizePolygon } from '../../model/polygonOps';
import { newBoardRecord } from '../altium/board6';
import { assemblePcbDoc, applyStackLayers, type StackCopper } from '../altium/assemble';
import { encodeArc, encodePad, encodeRegion, encodeText, encodeTrack, encodeVia, layerToName, writePcbDoc, writeVertices, type PadFields } from '../altium/pcbdoc';
import type { FootprintDef } from '../altium/pcblib';
import type { PcbRawRecord } from '../altium/framing';
import { PropertyBag } from '../altium/props';
import { altiumFloat } from '../altium/pcbTransform';
import { newPolygonProps } from '../altium/polygonProps';
import { newRule } from '../altium/rules';
import { boardRules, uniqueIdFor } from '../kicad/board';
import { strokeTextWidth } from '../gerber/stroke';
import { insidePoly, nearestLoops } from '../easyeda/stdPcb';
import { attrNum, kid, kidsOf, type XEl } from '../xml';
import { autoNet, rotOf, ruleLen, type ELib, type ERot, type EagleDoc } from './read';
import { curveArc, footprintNames, placer } from './sch';

export interface EagleBrdResult {
  bytes: Uint8Array; name: string; footprints: FootprintDef[]; warnings: string[];
  /** Each net's EAGLE signal (by the board's net index), and the copper layers EAGLE numbered (AD layer → EAGLE's number): for the way back (kept.ts). */
  signals: string[]; layers: Map<number, number>;
  stats: { components: number; pads: number; vias: number; tracks: number; nets: number; layers: number; pours: number };
}

const num = (e: XEl, a: string, d = 0) => attrNum(e, a, d);
const norm = (a: number) => ((a % 360) + 360) % 360;
const yes = (e: XEl, a: string, d: boolean) => { const v = e.attrs[a]; return v === undefined || v === '' ? d : v === 'yes'; };

/* ── layers ── */

/** A mirrored element's layers: top and bottom swapped (the inner copper turned over too). */
export function flipLayer(n: number): number {
  if (n >= 1 && n <= 16) return 17 - n;
  const pairs: Record<number, number> = { 21: 22, 23: 24, 25: 26, 27: 28, 29: 30, 31: 32, 33: 34, 35: 36, 37: 38, 39: 40, 41: 42, 51: 52 };
  for (const [a, b] of Object.entries(pairs)) { if (n === Number(a)) return b; if (n === b) return Number(a); }
  return n;
}
/** EAGLE's documentation layers on AD's mechanical layers: their number and name. */
const MECH: Record<number, [number, string]> = {
  20: [1, 'Dimension'], 46: [2, 'Milling'], 47: [3, 'Measures'], 48: [4, 'Document'], 49: [5, 'Reference'],
  51: [13, 'tDocu'], 52: [14, 'bDocu'], 27: [15, 'tValues'], 28: [16, 'bValues'], 39: [17, 'tKeepout'], 40: [18, 'bKeepout'],
  35: [19, 'tGlue'], 36: [20, 'bGlue'], 33: [21, 'tFinish'], 34: [22, 'bFinish'], 37: [23, 'tTest'], 38: [24, 'bTest'], 43: [25, 'vRestrict'],
};
const MECH_FREE = [6, 7, 8, 9, 10, 11, 12, 26, 27, 28, 29, 30, 31, 32];
/** EAGLE's generated layers: nothing drawn on them is the board's. */
const VIRTUAL = new Set([17, 18, 19, 23, 24, 44, 45]);

interface Rules { rv: (k: string, d: number) => number; rl: (k: string, d: number) => number; raw: Map<string, string> }
function rulesOf(board: XEl | undefined): Rules {
  const raw = new Map<string, string>();
  for (const p of kidsOf(kid(board, 'designrules'), 'param')) raw.set(p.attrs.name ?? '', p.attrs.value ?? '');
  return {
    raw,
    rv: (k, d) => { const v = Number(raw.get(k)); return Number.isFinite(v) && raw.has(k) ? v : d; },
    rl: (k, d) => ruleLen(raw.get(k)) ?? d,
  };
}
const clamp = (lo: number, v: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A package to place: a board element's, or a library's laid out alone. */
interface Elem { name: string; lib: ELib | undefined; pkg: XEl; pkgName: string; x: number; y: number; rot: ERot; value: string; attrs: Map<string, string>; smashed: Map<string, XEl> | null; locked: boolean; populate: boolean }

export function convertEagleBrd(doc: EagleDoc, name: string, opts: { stem?: string; packages?: { lib: ELib; pkg: string }[]; names?: (lib: ELib, pkg: string) => string; /** An automatic net's name as the schematic's compile gives it, by its pins ("R1.2"). */ netName?: (pins: string[]) => string | undefined;
  /** The schematic's parts (a paired board) and their values: an element of no part is a graphical component, one of no value takes the part's. */ parts?: Map<string, string> } = {}): EagleBrdResult {
  const board = doc.board;
  const warnings: string[] = [];
  const warned = new Set<string>();
  const warnOnce = (w: string) => { if (!warned.has(w)) { warned.add(w); warnings.push(w); } };
  const tally = new Map<string, number>();
  const skip = (what: string) => tally.set(what, (tally.get(what) ?? 0) + 1);
  const R = rulesOf(board);
  const stem = opts.stem ?? name;
  const fpName = opts.names ?? footprintNames(doc.libraries);

  /* The elements: the board's, or each package asked for alone on a grid */
  const elems: Elem[] = [];
  if (opts.packages) {
    opts.packages.forEach(({ lib, pkg }, i) => {
      const el = lib.packages.get(pkg);
      if (el) elems.push({ name: `F${i + 1}`, lib, pkg: el, pkgName: fpName(lib, pkg), x: (i % 10) * 50, y: Math.floor(i / 10) * 50, rot: { angle: 0, mirror: false, spin: false }, value: '', attrs: new Map(), smashed: null, locked: false, populate: true });
    });
  } else {
    for (const e of kidsOf(kid(board, 'elements'), 'element')) {
      const lib = doc.lib(e.attrs.library ?? '', e.attrs.library_urn ?? '');
      const pkg = lib?.packages.get(e.attrs.package ?? '');
      if (!lib || !pkg) { skip('elements whose package is missing'); continue; }
      const attrs = new Map(kidsOf(e, 'attribute').filter((a) => a.attrs.value !== undefined).map((a) => [(a.attrs.name ?? '').toUpperCase(), a.attrs.value ?? '']));
      const smashedOn = (e.attrs.smashed ?? 'no') === 'yes';
      elems.push({ name: e.attrs.name ?? '', lib, pkg, pkgName: fpName(lib, e.attrs.package ?? ''), x: num(e, 'x'), y: num(e, 'y'), rot: rotOf(e.attrs.rot), value: e.attrs.value ?? '',
        attrs, smashed: smashedOn ? new Map(kidsOf(e, 'attribute').map((a) => [(a.attrs.name ?? '').toUpperCase(), a])) : null, locked: yes(e, 'locked', false), populate: yes(e, 'populate', true) });
    }
  }

  /* Copper layers: the active ones of 1–16 (and any in use), in order */
  const used = new Set<number>();
  const seeLayers = (holder: XEl | undefined) => { if (!holder) return; for (const c of holder.children) { if (c.attrs.layer) used.add(num(c, 'layer')); if (c.name === 'via' && c.attrs.extent) for (const x of c.attrs.extent.split('-')) used.add(Number(x)); } };
  seeLayers(kid(board, 'plain'));
  for (const s of kidsOf(kid(board, 'signals'), 'signal')) seeLayers(s);
  for (const e of elems) for (const c of e.pkg.children) if (c.name === 'smd' || c.attrs.layer) used.add(e.rot.mirror ? flipLayer(num(c, 'layer', 1)) : num(c, 'layer', 1));
  const copperNums = [...new Set([1, 16, ...[...doc.layers].filter(([n, l]) => n >= 1 && n <= 16 && l.active).map(([n]) => n), ...[...used].filter((n) => n >= 1 && n <= 16)])].sort((a, b) => a - b).slice(0, 32);
  const copperIdOf = new Map<number, LayerId>(copperNums.map((n, i) => [n, (i === 0 ? L.TOP : i === copperNums.length - 1 ? L.BOTTOM : (L.MID1 + i - 1)) as LayerId]));
  const isCopper = (n: number) => copperIdOf.has(n);
  const mechNames = new Map<number, string>([[1, 'Dimension']]);
  const mechByLayer = new Map<number, number>();
  let mechNext = 0;
  /** An EAGLE layer's AD layer (null: not the board's, or a keep-out layer handled apart). */
  const layerOf = (n: number): LayerId | null => {
    const c = copperIdOf.get(n);
    if (c !== undefined) return c;
    switch (n) {
      case 21: case 25: return L.TOP_OVERLAY;
      case 22: case 26: return L.BOTTOM_OVERLAY;
      case 29: return L.TOP_SOLDER;
      case 30: return L.BOTTOM_SOLDER;
      case 31: return L.TOP_PASTE;
      case 32: return L.BOTTOM_PASTE;
      default:
    }
    if (VIRTUAL.has(n) || n === 41 || n === 42 || (n >= 1 && n <= 16) || (n >= 90 && n <= 99)) return null;
    let m = MECH[n]?.[0] ?? mechByLayer.get(n);
    if (m === undefined) {
      m = mechNext < MECH_FREE.length ? MECH_FREE[mechNext++]! : 32;
      mechByLayer.set(n, m);
    }
    if (!mechNames.has(m)) mechNames.set(m, m === 32 && mechByLayer.size > MECH_FREE.length ? 'Other EAGLE Layers' : MECH[n]?.[1] ?? doc.layers.get(n)?.name ?? `Layer ${n}`);
    return mechLayer(m);
  };
  /** tRestrict and bRestrict: keep-outs on the top and bottom copper. */
  const restrictOf = (n: number): LayerId | null => (n === 41 ? L.TOP : n === 42 ? L.BOTTOM : null);

  /* Coordinates: EAGLE's origin AD's, 1000 mil in from the sheet's corner past what lies left of or below it */
  let x0 = 0, y0 = 0;
  const seePt = (x: number, y: number) => { if (x < x0) x0 = x; if (y < y0) y0 = y; };
  for (const w of kidsOf(kid(board, 'plain'), 'wire')) { seePt(num(w, 'x1'), num(w, 'y1')); seePt(num(w, 'x2'), num(w, 'y2')); }
  for (const e of elems) seePt(e.x - 10, e.y - 10);
  const P = (v: Vec2): Vec2 => ({ x: Math.round(mil(1000) + (v.x - x0) * UNITS_PER_MM), y: Math.round(mil(1000) + (v.y - y0) * UNITS_PER_MM) });
  const len = (v: number) => Math.max(0, Math.round(v * UNITS_PER_MM));

  /* Nets: the signals', and which pads they reach */
  const nets: string[] = [];
  const netIndex = new Map<string, number>();
  const netOf = (n: string): number => { let i = netIndex.get(n); if (i === undefined) { i = nets.length; nets.push(n); netIndex.set(n, i); } return i; };
  const padNet = new Map<string, number>();
  const signalClass = new Map<string, string>();
  let autoN = 1;
  const signals = kidsOf(kid(board, 'signals'), 'signal');
  const named = new Set(signals.map((s) => s.attrs.name ?? '').filter((n) => n && !autoNet(n)));
  const signalName = new Map<XEl, string>();
  const signalOf: string[] = [];
  for (const s of signals) {
    let nm = s.attrs.name ?? '';
    // An automatic name: the schematic's own for the net (AD names a net no label names by a pin of it)
    if ((!nm || autoNet(nm)) && opts.netName) {
      const k = opts.netName(kidsOf(s, 'contactref').map((c) => `${c.attrs.element ?? ''}.${c.attrs.pad ?? ''}`));
      if (k && !named.has(k) && !netIndex.has(k)) nm = k;
    }
    while (!nm || (netIndex.has(nm) && nm.startsWith('N$'))) nm = `N$${autoN++}`;
    signalName.set(s, nm);
    const ni = netOf(nm);
    signalOf[ni] = s.attrs.name ?? nm;
    signalClass.set(nm, s.attrs.class ?? '0');
    for (const c of kidsOf(s, 'contactref')) padNet.set(`${c.attrs.element ?? ''}\u0000${c.attrs.pad ?? ''}`, ni);
  }

  const compBags: PropertyBag[] = [];
  const pads: PcbRawRecord[] = [], tracks: PcbRawRecord[] = [], arcs: PcbRawRecord[] = [], vias: PcbRawRecord[] = [], regions: PcbRawRecord[] = [], texts: PcbRawRecord[] = [];
  const polygons: PropertyBag[] = [];
  const pourRank: { index: number; rank: number }[] = [];
  const isolates = new Map<number, string[]>();
  const directPolys: string[] = [];
  const outlineEdges: Edge[] = [];
  const millLoops: Edge[] = [];
  let nTracks = 0, nVias = 0, nPads = 0;

  /** A placement (mm → AD), its layers swapped when mirrored. */
  interface Place { pt: (v: Vec2) => Vec2; frame: (t: ERot) => ERot; rot: ERot; owner?: number; layer: (n: number) => number; elem?: Elem }
  const free: Place = { pt: P, frame: (t) => t, rot: { angle: 0, mirror: false, spin: false }, layer: (n) => n };
  const placeOf = (e: Elem, owner: number): Place => {
    const pl = placer(e.x, e.y, e.rot);
    return { pt: (v) => P(pl.pt(v)), frame: pl.frame, rot: e.rot, owner, elem: e, layer: (n) => (e.rot.mirror ? flipLayer(n) : n) };
  };
  const keepout = (rec: PcbRawRecord) => { rec.subs[0]![2] = 2; return rec; };

  /** A wire (straight or curved) on a layer. */
  const wireOf = (w: XEl, pl: Place, net?: number) => {
    const n = pl.layer(num(w, 'layer'));
    const a = pl.pt({ x: num(w, 'x1'), y: num(w, 'y1') }), b = pl.pt({ x: num(w, 'x2'), y: num(w, 'y2') });
    const curve = num(w, 'curve') * (pl.rot.mirror ? -1 : 1);
    const arc = curve ? curveArc(a, b, curve) : null;
    const width = Math.max(1, len(num(w, 'width')));
    if (n === 20 || n === 46) {
      const edge: Edge = arc ? { a, b, w: width, arc: { c: arc.c, r: arc.r, sa: arc.start, ea: arc.end < arc.start ? arc.end + 360 : arc.end } } : { a, b, w: width };
      (n === 20 ? outlineEdges : millLoops).push(edge);
    }
    const restrict = restrictOf(n);
    const layer = restrict ?? layerOf(n);
    if (layer === null) { if (n !== 19) skip(`drawings on ${doc.layers.get(n)?.name ?? `layer ${n}`}`); return; }
    const rec = arc ? encodeArc({ layer, c: { x: Math.round(arc.c.x), y: Math.round(arc.c.y) }, r: Math.round(arc.r), start: arc.start, end: arc.end, width, net: isCopper(n) ? net : undefined, component: pl.owner })
      : encodeTrack({ layer, a, b, width, net: isCopper(n) ? net : undefined, component: pl.owner });
    (arc ? arcs : tracks).push(restrict !== null ? keepout(rec) : rec);
    nTracks++;
  };
  /** A polygon's outline (its curves stepped), placed. */
  const ringOf = (e: XEl, pl: Place): Vec2[] => {
    const vs = kidsOf(e, 'vertex');
    if (vs.length > 2 && num(vs[0]!, 'x') === num(vs.at(-1)!, 'x') && num(vs[0]!, 'y') === num(vs.at(-1)!, 'y')) vs.pop();
    const out: Vec2[] = [];
    vs.forEach((v, i) => {
      const a = { x: num(v, 'x'), y: num(v, 'y') }, nx = vs[(i + 1) % vs.length]!, b = { x: num(nx, 'x'), y: num(nx, 'y') };
      out.push(pl.pt(a));
      const curve = num(v, 'curve');
      const arc = curve ? curveArc(a, b, curve) : null;
      if (arc) {
        const k = Math.max(2, Math.ceil(Math.abs(curve) / 6));
        const a0 = Math.atan2(a.y - arc.c.y, a.x - arc.c.x), th = (curve * Math.PI) / 180;
        for (let j = 1; j < k; j++) out.push(pl.pt({ x: arc.c.x + arc.r * Math.cos(a0 + (th * j) / k), y: arc.c.y + arc.r * Math.sin(a0 + (th * j) / k) }));
      }
    });
    return out;
  };
  /** A circle: a filled disc when its width is 0 (an arc as wide as its radius), else a ring. */
  const circleOf = (e: XEl, pl: Place) => {
    const n = pl.layer(num(e, 'layer'));
    const c = pl.pt({ x: num(e, 'x'), y: num(e, 'y') }), r = len(num(e, 'radius')), w = len(num(e, 'width'));
    if (n === 20 || n === 46) {
      (n === 20 ? outlineEdges : millLoops).push({ a: { x: c.x + r, y: c.y }, b: { x: c.x - r, y: c.y }, arc: { c, r, sa: 0, ea: 180 } }, { a: { x: c.x - r, y: c.y }, b: { x: c.x + r, y: c.y }, arc: { c, r, sa: 180, ea: 360 } });
    }
    const restrict = restrictOf(n);
    const layer = restrict ?? layerOf(n);
    if (layer === null) { skip(`drawings on ${doc.layers.get(n)?.name ?? `layer ${n}`}`); return; }
    const rec = w > 0 ? encodeArc({ layer, c, r, start: 0, end: 360, width: w, component: pl.owner }) : encodeArc({ layer, c, r: Math.round(r / 2), start: 0, end: 360, width: r, component: pl.owner });
    arcs.push(restrict !== null ? keepout(rec) : rec);
  };
  /** A rectangle (always filled), turned about its centre. */
  const rectOf = (e: XEl, pl: Place) => {
    const n = pl.layer(num(e, 'layer'));
    const x1 = num(e, 'x1'), y1 = num(e, 'y1'), x2 = num(e, 'x2'), y2 = num(e, 'y2'), cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
    const inner = placer(cx, cy, rotOf(e.attrs.rot));
    const pts = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]].map(([x, y]) => pl.pt(inner.pt({ x: x! - cx, y: y! - cy })));
    const restrict = restrictOf(n);
    const layer = restrict ?? layerOf(n);
    if (layer === null) { skip(`drawings on ${doc.layers.get(n)?.name ?? `layer ${n}`}`); return; }
    const rec = encodeRegion({ layer, outline: pts, component: pl.owner });
    regions.push(restrict !== null ? keepout(rec) : rec);
  };

  /** A text: EAGLE's vector text as AD's stroke text, its anchor by its alignment, kept readable (unless spun). */
  const textRec = (text: string, layerN: number, at0: Vec2, e: XEl, t: ERot, owner?: number, role?: 'designator' | 'comment') => {
    const layer = layerOf(layerN) ?? restrictOf(layerN);
    if (layer === null || (!text && !role)) { if (text) skip(`text on ${doc.layers.get(layerN)?.name ?? `layer ${layerN}`}`); return; }
    const size = num(e, 'size', 1.27), ratio = num(e, 'ratio', 8);
    const stroke = Math.max(1, len((size * ratio) / 100)), h = Math.max(mil(4), len(size) - stroke);
    let [hh, vv] = alignOf(e.attrs.align);
    let a = norm(t.mirror ? -t.angle : t.angle);
    if (!t.spin && (t.mirror ? a >= 90 && a < 270 : a > 90 && a <= 270)) { a = norm(a - 180); hh = 2 - hh; vv = 2 - vv; }
    const lines = text.replace(/\r/g, '').split('\n');
    const th = (a * Math.PI) / 180, ux = Math.cos(th), uy = Math.sin(th), dir = t.mirror ? -1 : 1;
    const pitch = len(size * (1 + num(e, 'distance', 50) / 100));
    const block = h + (lines.length - 1) * pitch;
    lines.forEach((line, i) => {
      if (!line.trim() && !(role && i === 0)) return;
      const w = strokeTextWidth(line, h);
      // This line's baseline: up from the block's foot by the lines below it, the block placed by its anchor
      const up = (lines.length - 1 - i) * pitch - (vv / 2) * block;
      const along = (hh / 2) * w * dir;
      const at = { x: Math.round(at0.x - along * ux - up * uy), y: Math.round(at0.y - along * uy + up * ux) };
      texts.push(encodeText({ layer, at, height: h, text: line, rotation: a, strokeWidth: stroke, mirrored: t.mirror, component: owner, isDesignator: role === 'designator' && i === 0, isComment: role === 'comment' && i === 0 }));
    });
  };

  /** A polygon: on copper in a signal a pour of its net (a cut-out one a polygon cut-out); on a restrict layer a keep-out; elsewhere a filled region. */
  const polygonOf = (e: XEl, pl: Place, net?: number, signal?: string) => {
    const n = pl.layer(num(e, 'layer'));
    const ring = ringOf(e, pl);
    if (ring.length < 3) return;
    const restrict = restrictOf(n);
    if (restrict !== null) { regions.push(keepout(encodeRegion({ layer: restrict, outline: ring, component: pl.owner }))); return; }
    const pour = e.attrs.pour ?? 'solid';
    if (isCopper(n) && pl.owner === undefined) {
      const layer = copperIdOf.get(n)!;
      if (pour === 'cutout') { regions.push(encodeRegion({ layer, outline: ring, kind: 1 })); return; }
      const width = num(e, 'width');
      // EAGLE's pen runs on the outline: its copper reaches half the width past it
      const grown = width > 0 ? resizePolygon({ outline: ring } as PcbPolygon, len(width) / 2)[0] ?? ring : ring;
      const index = polygons.length;
      const pname = `${signal || 'No Net'}_${index + 1}`;
      const bag = newPolygonProps(layerToName(layer), net ?? 0xffff, pname, index);
      writeVertices(bag, grown.map((q): PolyVertex => ({ p: { x: Math.round(q.x), y: Math.round(q.y) } })));
      bag.set('TRACKWIDTH', formatAltiumLength(Math.max(mil(1), len(width || 0.254))));
      bag.set('REMOVEDEAD', yes(e, 'orphans', false) ? 'FALSE' : 'TRUE');
      if (pour === 'hatch') { bag.set('HATCHSTYLE', '90Degree'); bag.set('GRIDSIZE', formatAltiumLength(Math.max(len(width) + mil(1), len(num(e, 'spacing', 1.27))))); }
      polygons.push(bag);
      pourRank.push({ index, rank: num(e, 'rank', 1) });
      const iso = num(e, 'isolate');
      if (iso > 0) { const k = Math.round(iso * 10000) / 10000; isolates.set(k, [...(isolates.get(k) ?? []), pname]); }
      if (!yes(e, 'thermals', true)) directPolys.push(pname);
      if (net === undefined) warnOnce('Polygons on copper of no signal poured as pours of no net');
      return;
    }
    const layer = layerOf(n);
    if (layer === null) { skip(`drawings on ${doc.layers.get(n)?.name ?? `layer ${n}`}`); return; }
    if (n === 20 || n === 46) for (let i = 0; i < ring.length; i++) (n === 20 ? outlineEdges : millLoops).push({ a: ring[i]!, b: ring[(i + 1) % ring.length]! });
    regions.push(encodeRegion({ layer, outline: ring, component: pl.owner }));
  };

  /* ── pads ── */
  const useDia = R.rv('useDiameter', 13);
  /** A through-hole pad's diameter on a layer group: the library's if it is used and larger, else the restring rule's. */
  const padDia = (drill: number, dia: number, group: 'Top' | 'Inner' | 'Bottom') => {
    const ring = clamp(R.rl(`rlMinPad${group}`, 0.254), drill * R.rv(`rvPad${group}`, 0.25), R.rl(`rlMaxPad${group}`, 0.508));
    const ruled = drill + 2 * ring;
    const bit = group === 'Top' ? 1 : group === 'Inner' ? 2 : 4;
    return dia > 0 && useDia & bit ? Math.max(dia, ruled) : ruled;
  };
  const maskFrame = (w: number, h: number) => clamp(R.rl('mlMinStopFrame', 0.1016), R.rv('mvStopFrame', 1) * Math.min(w, h), R.rl('mlMaxStopFrame', 0.1016));
  const creamFrame = (w: number, h: number) => clamp(R.rl('mlMinCreamFrame', 0), R.rv('mvCreamFrame', 0) * Math.min(w, h), R.rl('mlMaxCreamFrame', 0));
  const maskIsRule = R.rl('mlMinStopFrame', 0.1016) === R.rl('mlMaxStopFrame', 0.1016);
  const creamIsRule = R.rl('mlMinCreamFrame', 0) === R.rl('mlMaxCreamFrame', 0);
  const SHAPES = ['square', 'round', 'octagon'];
  /** The milling slots in a package: their segments (mm, package's own). */
  /**
   * The milling in a package: slots drawn along their middle with the cutter's width, and slots
   * drawn round as closed outlines (width 0); each with its wires, its middle, length and width (mm, package's own).
   */
  interface Mill { els: XEl[]; c: Vec2; length: number; width: number; angle: number }
  const millOf = (pkg: XEl): Mill[] => {
    const ws = kidsOf(pkg, 'wire').filter((w) => num(w, 'layer') === 46);
    const out: Mill[] = [];
    for (const w of ws) {
      if (num(w, 'width') <= 0 || num(w, 'curve')) continue;
      const a = { x: num(w, 'x1'), y: num(w, 'y1') }, b = { x: num(w, 'x2'), y: num(w, 'y2') }, cw = num(w, 'width');
      out.push({ els: [w], c: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, length: Math.hypot(b.x - a.x, b.y - a.y) + cw, width: cw, angle: (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI });
    }
    // Outlines: width-0 wires chained end to end into closed loops
    const open = ws.filter((w) => num(w, 'width') <= 0);
    const used = new Set<XEl>();
    const key = (x: number, y: number) => `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
    for (const start of open) {
      if (used.has(start)) continue;
      const chain = [start];
      used.add(start);
      const first = key(num(start, 'x1'), num(start, 'y1'));
      let end = key(num(start, 'x2'), num(start, 'y2'));
      for (let guard = 0; end !== first && guard < 64; guard++) {
        const nx = open.find((w) => !used.has(w) && (key(num(w, 'x1'), num(w, 'y1')) === end || key(num(w, 'x2'), num(w, 'y2')) === end));
        if (!nx) break;
        used.add(nx); chain.push(nx);
        end = key(num(nx, 'x1'), num(nx, 'y1')) === end ? key(num(nx, 'x2'), num(nx, 'y2')) : key(num(nx, 'x1'), num(nx, 'y1'));
      }
      if (end !== first) continue;
      const pts = chain.flatMap((w) => [{ x: num(w, 'x1'), y: num(w, 'y1') }, { x: num(w, 'x2'), y: num(w, 'y2') }]);
      // Arcs bulge past their ends: their middles too
      for (const w of chain) {
        const arc = num(w, 'curve') ? curveArc({ x: num(w, 'x1'), y: num(w, 'y1') }, { x: num(w, 'x2'), y: num(w, 'y2') }, num(w, 'curve')) : null;
        if (arc) { const m = (arc.start + norm(arc.end - arc.start) / 2) * Math.PI / 180; pts.push({ x: arc.c.x + arc.r * Math.cos(m), y: arc.c.y + arc.r * Math.sin(m) }); }
      }
      const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
      const w0 = Math.max(...xs) - Math.min(...xs), h0 = Math.max(...ys) - Math.min(...ys);
      out.push({ els: chain, c: { x: (Math.max(...xs) + Math.min(...xs)) / 2, y: (Math.max(...ys) + Math.min(...ys)) / 2 }, length: Math.max(w0, h0), width: Math.min(w0, h0), angle: w0 >= h0 ? 0 : 90 });
    }
    return out;
  };
  const slotsUsed = new Set<object>();

  const thPad = (p: XEl, pl: Place, net: number | undefined, mill: ReturnType<typeof millOf>) => {
    const drill = num(p, 'drill');
    const local = { x: num(p, 'x'), y: num(p, 'y') };
    const at = pl.pt(local);
    const prot = rotOf(p.attrs.rot).angle;
    const rotation = norm(pl.rot.mirror ? -(pl.rot.angle + prot) : pl.rot.angle + prot);
    let shape = p.attrs.shape ?? 'round';
    const first = yes(p, 'first', false);
    const override = first && R.rv('psFirst', -1) >= 0 ? R.rv('psFirst', -1) : R.rv('psTop', -1);
    const overBot = first && R.rv('psFirst', -1) >= 0 ? R.rv('psFirst', -1) : R.rv('psBottom', -1);
    const dia = num(p, 'diameter');
    const dTop = padDia(drill, dia, 'Top'), dBot = padDia(drill, dia, 'Bottom'), dIn = padDia(drill, dia, 'Inner');
    const elong = 1 + R.rv('psElongationLong', 100) / 100;
    const sizeOf = (d: number, sh: string): { w: number; h: number; shape: PadFields['shape'] } => {
      if (sh === 'square') return { w: len(d), h: len(d), shape: 'rect' };
      if (sh === 'octagon') return { w: len(d), h: len(d), shape: 'octagon' };
      if (sh === 'long' || sh === 'offset') return { w: len(d * elong), h: len(d), shape: 'round' };
      return { w: len(d), h: len(d), shape: 'round' };
    };
    const topShape = SHAPES.includes(shape) && override >= 0 && override <= 2 ? SHAPES[override]! : shape;
    const botShape = SHAPES.includes(shape) && overBot >= 0 && overBot <= 2 ? SHAPES[overBot]! : shape;
    // A milling slot within the pad: its hole a slot along it
    let slot: PadFields['slot'];
    const ms = mill.find((m) => !m.els.some((e) => slotsUsed.has(e)) && m.width > 0 && Math.hypot(m.c.x - local.x, m.c.y - local.y) < Math.max(dTop * elong, dia) / 2);
    let hole = len(drill);
    if (ms) {
      for (const e of ms.els) slotsUsed.add(e);
      hole = len(ms.width);
      if (ms.length > ms.width + 0.001) slot = { length: len(ms.length), rotation: norm((pl.rot.mirror ? -(pl.rot.angle + ms.angle) : pl.rot.angle + ms.angle) - rotation) };
      warnOnce('Milling slots within pads made the pads\' slotted holes');
    }
    const top = sizeOf(dTop, topShape), bot = sizeOf(dBot, botShape), mid = { w: len(dIn), h: len(dIn), shape: 'round' as const };
    const ensure = (q: { w: number; h: number; shape: PadFields['shape'] }) => ({ ...q, w: Math.max(q.w, hole + 1), h: Math.max(q.h, slot ? hole + 1 : hole + 1) });
    const t = ensure(top), b = ensure(bot), m = ensure(mid);
    const same = (x: typeof t, y: typeof t) => x.w === y.w && x.h === y.h && x.shape === y.shape;
    const stop = yes(p, 'stop', true);
    const solderExpansion = !stop ? -Math.max(t.w, t.h) : maskIsRule ? undefined : len(maskFrame(dTop, dTop));
    const name = p.attrs.name ?? '';
    if (shape === 'offset') {
      // An offset pad: its oval beside its hole as copper, a ring round the hole the pad
      const off = len((dTop * elong - dTop) / 2);
      const ux = Math.cos((rotation * Math.PI) / 180), uy = Math.sin((rotation * Math.PI) / 180);
      const c = { x: at.x + ux * off, y: at.y + uy * off };
      for (const [layer, q] of [[L.TOP, t], [L.BOTTOM, b]] as const) {
        const r = q.h / 2, half = q.w / 2 - r;
        const pts: Vec2[] = [];
        for (let k = 0; k <= 12; k++) { const a = -Math.PI / 2 + (Math.PI * k) / 12; pts.push({ x: half + r * Math.cos(a), y: r * Math.sin(a) }); }
        for (let k = 0; k <= 12; k++) { const a = Math.PI / 2 + (Math.PI * k) / 12; pts.push({ x: -half + r * Math.cos(a), y: r * Math.sin(a) }); }
        regions.push(encodeRegion({ layer, outline: pts.map((q2) => ({ x: Math.round(c.x + q2.x * ux - q2.y * uy), y: Math.round(c.y + q2.x * uy + q2.y * ux) })), net, component: pl.owner }));
      }
      const ring = Math.min(t.h, hole + len(0.4));
      pads.push(encodePad({ name, layer: L.MULTI, at, w: ring, h: ring, shape: 'round', rotation, hole, slot, net, component: pl.owner, solderExpansion: !stop ? -ring : undefined }));
      warnOnce('Offset pads made of their copper and a round pad at the hole');
      nPads++;
      return;
    }
    const tmb = !same(t, b) || !same(t, m);
    pads.push(encodePad({ name, layer: L.MULTI, at, w: t.w, h: t.h, shape: t.shape, rotation, hole, slot, plated: true, net, component: pl.owner,
      ...(tmb ? { mid: m, bot: b } : {}), solderExpansion }));
    if (!yes(p, 'thermals', true)) warnOnce('Pads with thermals off connect to pours as the design rules have it');
    nPads++;
  };
  const smdPad = (p: XEl, pl: Place, net: number | undefined) => {
    const dx = num(p, 'dx'), dy = num(p, 'dy');
    if (dx <= 0 || dy <= 0) { skip('SMD pads of no size'); return; }
    const n = pl.layer(num(p, 'layer', 1));
    const layer = copperIdOf.get(n);
    if (layer === undefined) { skip('SMD pads off copper'); return; }
    const at = pl.pt({ x: num(p, 'x'), y: num(p, 'y') });
    const prot = rotOf(p.attrs.rot).angle;
    const rotation = norm(pl.rot.mirror ? -(pl.rot.angle + prot) : pl.rot.angle + prot);
    const half = Math.min(dx, dy) / 2;
    const r = Math.max((num(p, 'roundness') / 100) * half, clamp(R.rl('srMinRoundness', 0), R.rv('srRoundness', 0) * half, R.rl('srMaxRoundness', 0)));
    const pct = half > 0 ? Math.min(100, Math.round((r / half) * 100)) : 0;
    const w = len(dx), h = len(dy);
    const shape: PadFields['shape'] = pct >= 100 ? 'round' : pct > 0 ? 'roundrect' : 'rect';
    const stop = yes(p, 'stop', true), cream = yes(p, 'cream', true);
    pads.push(encodePad({ name: p.attrs.name ?? '', layer, at, w, h, shape, cornerPct: shape === 'roundrect' ? pct : undefined, rotation, net, component: pl.owner,
      solderExpansion: !stop ? -Math.max(w, h) : maskIsRule ? undefined : len(maskFrame(dx, dy)),
      pasteExpansion: !cream ? -Math.max(w, h) : creamIsRule ? undefined : -len(creamFrame(dx, dy)) }));
    nPads++;
  };
  const holeOf = (e: XEl, pl: Place) => {
    const d = len(num(e, 'drill'));
    if (d <= 0) return;
    pads.push(encodePad({ name: '', layer: L.MULTI, at: pl.pt({ x: num(e, 'x'), y: num(e, 'y') }), w: d, h: d, shape: 'round', hole: d, plated: false, component: pl.owner }));
  };

  /** A package's or the board's drawing and copper through a placement. */
  const prim = (e: XEl, pl: Place, net?: number, signal?: string) => {
    switch (e.name) {
      case 'wire': {
        const n = num(e, 'layer');
        // A milling slot that went into a pad's hole is that pad's
        if (n === 46 && slotsUsed.has(e)) return;
        if (pl.layer(n) === 19) return;
        wireOf(e, pl, net); return;
      }
      case 'circle': circleOf(e, pl); return;
      case 'rectangle': rectOf(e, pl); return;
      case 'polygon': polygonOf(e, pl, net, signal); return;
      case 'hole': holeOf(e, pl); return;
      case 'via': {
        const at = pl.pt({ x: num(e, 'x'), y: num(e, 'y') });
        const drill = num(e, 'drill');
        const dia = num(e, 'diameter');
        const ring = clamp(R.rl('rlMinViaOuter', 0.254), drill * R.rv('rvViaOuter', 0.25), R.rl('rlMaxViaOuter', 0.508));
        const d = dia > drill && useDia & 8 ? Math.max(dia, drill + 2 * ring) : drill + 2 * ring;
        const [s0, s1] = (e.attrs.extent ?? '1-16').split('-').map(Number);
        const a = Math.min(s0 ?? 1, s1 ?? 16), b = Math.max(s0 ?? 1, s1 ?? 16);
        const la = copperIdOf.get(a) ?? copperIdOf.get(copperNums.find((x) => x >= a) ?? 1), lb = copperIdOf.get(b) ?? copperIdOf.get([...copperNums].reverse().find((x) => x <= b) ?? 16);
        if (e.attrs.shape && e.attrs.shape !== 'round') warnOnce('Square and octagonal vias made round');
        vias.push(encodeVia({ at, diameter: len(d), hole: len(drill), net, ...(la !== L.TOP || lb !== L.BOTTOM ? { layerStart: la, layerEnd: lb } : {}) }));
        nVias++;
        return;
      }
      case 'text': {
        const raw = e.text ?? '';
        let text = raw;
        const key = raw.startsWith('>') ? raw.slice(1).trim().toUpperCase() : '';
        if (key) {
          const el = pl.elem;
          if (key === 'NAME' || key === 'VALUE') return;   // the element's own, placed apart
          text = el?.attrs.get(key) ?? (key === 'PART' ? el?.name : undefined) ?? docAttr(key) ?? '';
        }
        textRec(text, pl.layer(num(e, 'layer')), pl.pt({ x: num(e, 'x'), y: num(e, 'y') }), e, pl.frame(rotOf(e.attrs.rot)), pl.owner);
        return;
      }
      case 'dimension': skip('dimensions'); return;
      case 'spline': skip('splines'); return;
      case 'frame': return;
      default:
    }
  };
  const globalAttrs = new Map(kidsOf(kid(board, 'attributes'), 'attribute').map((a) => [(a.attrs.name ?? '').toUpperCase(), a.attrs.value ?? '']));
  const docAttr = (k: string) => globalAttrs.get(k) ?? (k === 'DRAWING_NAME' ? stem : undefined);

  /* ── the board's drawing, then the signals' copper ── */
  for (const e of kid(board, 'plain')?.children ?? []) prim(e, free);
  for (const s of signals) {
    const nm = signalName.get(s) ?? s.attrs.name ?? '';
    const ni = netIndex.get(nm);
    for (const e of s.children) {
      if (e.name === 'contactref') continue;
      if (e.name === 'wire' && !isCopper(num(e, 'layer'))) { if (num(e, 'layer') !== 19) skip('signal wires off copper'); continue; }
      prim(e, free, ni, nm);
    }
  }

  /* ── the elements ── */
  let nComps = 0;
  for (const el of elems) {
    const ci = compBags.length;
    const pl = placeOf(el, ci);
    const pos = P({ x: el.x, y: el.y });
    const bottom = el.rot.mirror;
    // AD's bottom part: reflected top to bottom, then turned (EAGLE's M·R(a) is AD's 180 − a)
    const rot = norm(bottom ? 180 - el.rot.angle : el.rot.angle);
    const nameAttr = el.smashed?.get('NAME'), valueAttr = el.smashed?.get('VALUE');
    const shown = (a: XEl | undefined, fallback: boolean) => (el.smashed ? !!a && (a.attrs.display ?? 'value') !== 'off' : fallback);
    const pkgText = (k: string) => kidsOf(el.pkg, 'text').find((t) => (t.text ?? '').trim().toUpperCase() === `>${k}`);
    // On the board only (a logo, a fiducial added there): AD's graphical component, which the schematic doesn't keep
    const lone = !!opts.parts && !opts.parts.has(el.name.toUpperCase());
    if (lone) warnOnce('Elements on the board only (logos, fiducials) made graphical components, kept out of the schematic\'s comparison');
    if (!el.value && opts.parts?.get(el.name.toUpperCase())) el.value = opts.parts.get(el.name.toUpperCase())!;
    compBags.push(PropertyBag.from({
      LAYER: bottom ? 'BOTTOM' : 'TOP', PATTERN: el.pkgName, SOURCEDESIGNATOR: el.name, SOURCEFOOTPRINTLIBRARY: `${stem}.PcbLib`,
      X: formatAltiumLength(pos.x), Y: formatAltiumLength(pos.y), ROTATION: altiumFloat(rot),
      NAMEON: shown(nameAttr, !!pkgText('NAME')) ? 'TRUE' : 'FALSE', COMMENTON: shown(valueAttr, !!pkgText('VALUE')) ? 'TRUE' : 'FALSE', LOCKED: el.locked ? 'TRUE' : 'FALSE',
      COMPONENTKIND: lone ? 2 : el.populate ? 0 : 5, SOURCELIBREFERENCE: '', SOURCEUNIQUEID: lone ? '' : `\\${uniqueIdFor(`eagle:${stem}:${el.name}`)}`, FOOTPRINTDESCRIPTION: '',
    }));
    const mill = millOf(el.pkg);
    // Pads first (a milling slot within one is its hole), then the rest
    for (const e of el.pkg.children) {
      const net = padNet.get(`${el.name}\u0000${e.attrs.name ?? ''}`);
      if (e.name === 'pad') thPad(e, pl, net, mill);
      else if (e.name === 'smd') smdPad(e, pl, net);
    }
    for (const e of el.pkg.children) if (e.name !== 'pad' && e.name !== 'smd') prim(e, pl);
    // The name and value: where the element shows them (smashed), else where the package does
    const field = (k: 'NAME' | 'VALUE', text: string, role: 'designator' | 'comment') => {
      const a = el.smashed?.get(k);
      const t = a ?? (el.smashed ? undefined : pkgText(k));
      if (a) { const d = a.attrs.display ?? 'value'; const tx = d === 'name' ? k : d === 'both' ? `${k} = ${text}` : text; textRec(tx, num(a, 'layer', bottom ? 26 : 25), P({ x: num(a, 'x'), y: num(a, 'y') }), a, rotOf(a.attrs.rot), ci, role); return; }
      if (t) { textRec(text, pl.layer(num(t, 'layer', 25)), pl.pt({ x: num(t, 'x'), y: num(t, 'y') }), t, pl.frame(rotOf(t.attrs.rot)), ci, role); return; }
      // Not shown: AD's designator and comment still the component's (hidden)
      texts.push(encodeText({ layer: bottom ? L.BOTTOM_OVERLAY : L.TOP_OVERLAY, at: pos, height: mil(50), text, rotation: 0, strokeWidth: mil(6), mirrored: bottom, component: ci, isDesignator: role === 'designator', isComment: role === 'comment' }));
    };
    field('NAME', el.name, 'designator');
    field('VALUE', el.value, 'comment');
    // The element's other attributes it shows
    for (const [k, a] of el.smashed ?? []) {
      if (k === 'NAME' || k === 'VALUE' || (a.attrs.display ?? 'value') === 'off' || a.attrs.x === undefined) continue;
      const v = el.attrs.get(k) ?? a.attrs.value ?? '';
      const d = a.attrs.display ?? 'value';
      textRec(d === 'name' ? k : d === 'both' ? `${k} = ${v}` : v, num(a, 'layer', 27), P({ x: num(a, 'x'), y: num(a, 'y') }), a, rotOf(a.attrs.rot), ci);
    }
    if (el.rot.angle % 90) warnOnce('Elements turned other than by quarter turns placed as turned');
    nComps++;
  }

  /* ── the board shape: Dimension's loops, the largest the board; the rest, and Milling's closed loops inside it, cut-outs ── */
  let loops: PolyVertex[][] = [];
  for (const tol of [mm(0.005), mm(0.05), mm(0.3)]) {
    loops = nearestLoops(outlineEdges, tol).filter((l) => l.length >= 2);
    const usedEdges = loops.reduce((k, l) => k + l.length, 0);
    if (loops.length && usedEdges >= outlineEdges.length * 0.8) break;
  }
  const loopArea = (vs: PolyVertex[]) => Math.abs(vs.reduce((a, v, i) => { const q = vs[(i + 1) % vs.length]!.p; return a + v.p.x * q.y - q.x * v.p.y; }, 0));
  let outline: PolyVertex[];
  const ringPts = (vs: PolyVertex[]): Vec2[] => {
    const out: Vec2[] = [];
    vs.forEach((v) => {
      out.push(v.p);
      if (v.arc) {
        const { c, r, sa, ea } = v.arc;
        // The arc's way from this vertex: the end nearer it is its start
        const at = (a: number) => ({ x: c.x + r * Math.cos((a * Math.PI) / 180), y: c.y + r * Math.sin((a * Math.PI) / 180) });
        const fwd = Math.hypot(at(sa).x - v.p.x, at(sa).y - v.p.y) <= Math.hypot(at(ea).x - v.p.x, at(ea).y - v.p.y);
        const k = Math.max(2, Math.ceil(Math.abs(ea - sa) / 6));
        for (let j = 1; j < k; j++) out.push(at(fwd ? sa + ((ea - sa) * j) / k : ea - ((ea - sa) * j) / k));
      }
    });
    return out;
  };
  if (loops.length) {
    loops.sort((a, b) => loopArea(b) - loopArea(a));
    outline = loops[0]!;
    for (const cut of loops.slice(1)) { const pts = ringPts(cut); if (pts.length >= 3) regions.push(encodeRegion({ layer: L.MULTI, outline: pts, boardCutout: true })); }
  } else {
    if (!opts.packages && (nComps || nTracks)) warnings.push('No board outline (Dimension layer): the board shape is drawn round the contents');
    const pts = compBags.map((b) => ({ x: Number.parseFloat(b.get('X') ?? '0') * 10000, y: Number.parseFloat(b.get('Y') ?? '0') * 10000 }));
    const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
    const lo = { x: Math.min(mil(1000), ...xs) - mil(200), y: Math.min(mil(1000), ...ys) - mil(200) }, hi = { x: Math.max(mil(1400), ...xs) + mil(200), y: Math.max(mil(1300), ...ys) + mil(200) };
    outline = [{ p: lo }, { p: { x: hi.x, y: lo.y } }, { p: hi }, { p: { x: lo.x, y: hi.y } }];
  }
  const shape = ringPts(outline);
  if (millLoops.length) {
    let cut = 0;
    for (const l of nearestLoops(millLoops, mm(0.01))) {
      const pts = ringPts(l);
      if (pts.length >= 3 && insidePoly(pts[0]!, shape)) { regions.push(encodeRegion({ layer: L.MULTI, outline: pts, boardCutout: true })); cut++; }
    }
    if (cut) warnOnce('Closed Milling loops within the board made board cut-outs');
  }
  // Open Dimension and Milling paths with a width: routed slots, cut out as wide as they are
  const openOf = (edges: Edge[], loopsOf: PolyVertex[][]) => {
    const verts = loopsOf.flat().map((v) => v.p);
    const near = (p: Vec2) => verts.some((q) => Math.hypot(q.x - p.x, q.y - p.y) <= mm(0.05));
    return edges.filter((e) => (e.w ?? 0) > 1 && !(near(e.a) && near(e.b)));
  };
  const open = [...openOf(outlineEdges, loops), ...openOf(millLoops, nearestLoops(millLoops, mm(0.01)))];
  if (open.length) {
    for (const ring of strokeOutline(open)) if (ring.length >= 3) regions.push(encodeRegion({ layer: L.MULTI, outline: ring, boardCutout: true }));
    warnOnce('Open Dimension and Milling paths with a width (routed slots) cut out of the board as wide as they are');
  }
  const xs = outline.map((v) => v.p.x), ys = outline.map((v) => v.p.y);
  const boardRec = newBoardRecord({ fileName: `${name}.PcbDoc`, origin: P({ x: 0, y: 0 }), outline,
    sheet: { x: 0, y: 0, width: Math.max(...xs) + mil(2000), height: Math.max(...ys) + mil(2000) }, mechanical: [...mechNames.keys()] });
  for (const [m, nm] of mechNames) boardRec.set(`LAYER${mechLayer(m)}NAME`, nm);

  pourRank.sort((a, b) => a.rank - b.rank || a.index - b.index).forEach((o, i) => polygons[o.index]!.set('POURINDEX', String(i)));

  /* ── the design rules and net classes ── */
  const classes = kidsOf(kid(board, 'classes'), 'class');
  const classByNum = new Map(classes.map((c) => [c.attrs.number ?? '0', c]));
  const clearanceOf = (c: XEl, other: string) => { const x = kidsOf(c, 'clearance').find((q) => (q.attrs.class ?? '0') === other); return x ? num(x, 'value') || undefined : undefined; };
  const viaDrill = R.rl('msDrill', 0.35);
  const viaRing = clamp(R.rl('rlMinViaOuter', 0.254), viaDrill * R.rv('rvViaOuter', 0.25), R.rl('rlMaxViaOuter', 0.508));
  const { rules, classes: classBags } = boardRules({
    clearance: R.rl('mdWireWire', 0.2032), minTrack: R.rl('msWidth', 0.2032), trackWidth: Math.max(R.rl('msWidth', 0.2032), 0.254),
    viaDrill, viaDiameter: viaDrill + 2 * viaRing, minDrill: R.rl('msDrill', 0.35), holeToHole: R.rl('mdDrill', 0.2032),
    classes: classes.filter((c) => !/^default$/i.test(c.attrs.name ?? '') && (c.attrs.number ?? '0') !== '0').map((c) => ({
      name: c.attrs.name || `Class${c.attrs.number}`, trackWidth: num(c, 'width') || undefined, viaDrill: num(c, 'drill') || undefined, clearance: clearanceOf(c, '0') ?? clearanceOf(c, c.attrs.number ?? ''),
      nets: nets.filter((n) => signalClass.get(n) === c.attrs.number),
    })),
  }, nets, nets);
  const rule = (kind: string) => rules.find((r) => r.bag.get('RULEKIND') === kind);
  const mmS = (v: number) => `${Math.round(v * 10000) / 10000}mm`;
  if (maskIsRule) rule('SolderMaskExpansion')?.bag.set('EXPANSION', mmS(R.rl('mlMinStopFrame', 0.1016)));
  if (creamIsRule) rule('PasteMaskExpansion')?.bag.set('EXPANSION', mmS(-R.rl('mlMinCreamFrame', 0)));
  const pc = rule('PolygonConnect');
  if (pc) pc.bag.set('AIRGAPWIDTH', mmS(R.rl('slThermalIsolate', 0.254)));
  // Clearances between two classes, and the pours' isolation, ahead of the board's clearance
  let prio = 1;
  const extra = [] as typeof rules;
  for (const c of classes) for (const q of kidsOf(c, 'clearance')) {
    const other = q.attrs.class ?? '0', v = num(q, 'value');
    if (!v || other === '0' || other === (c.attrs.number ?? '0')) continue;
    const a = c.attrs.name, b = classByNum.get(other)?.attrs.name;
    if (!a || !b) continue;
    const r = newRule('Clearance', `Clearance_${a}_${b}`, prio++);
    r.bag.set('SCOPE1EXPRESSION', `InNetClass('${a}')`); r.bag.set('SCOPE2EXPRESSION', `InNetClass('${b}')`); r.bag.set('GAP', mmS(v));
    extra.push(r);
  }
  for (const [v, names] of isolates) {
    if (v <= R.rl('mdWireWire', 0.2032) + 1e-6) continue;
    const r = newRule('Clearance', `PolygonIsolate_${String(v).replace('.', '_')}mm`, prio++);
    r.bag.set('SCOPE1EXPRESSION', names.map((n) => `InNamedPolygon('${n}')`).join(' or ')); r.bag.set('GAP', mmS(v));
    extra.push(r);
  }
  if (directPolys.length) {
    const r = newRule('PolygonConnect', 'PolygonConnect_Direct', prio++);
    r.bag.set('SCOPE1EXPRESSION', directPolys.map((n) => `InNamedPolygon('${n}')`).join(' or ')); r.bag.set('CONNECTSTYLE', 'Direct');
    extra.push(r);
  }
  if (extra.length) for (const r of rules) if (['Clearance', 'PolygonConnect'].includes(r.bag.get('RULEKIND') ?? '') && !extra.includes(r)) r.bag.set('PRIORITY', String(Number(r.bag.get('PRIORITY') ?? '1') + prio - 1));

  const pcbDoc = assemblePcbDoc({ board: boardRec, nets, comps: compBags, polygons, pads, tracks, vias, arcs, texts, regions, rules: [...extra, ...rules], classes: classBags }, `${name}.PcbDoc`);
  // The stack: the copper's names and thicknesses (mtCopper), the dielectrics' (mtIsolate)
  const thick = (R.raw.get('mtCopper') ?? '').split(/\s+/).map((v) => ruleLen(v));
  const isol = (R.raw.get('mtIsolate') ?? '').split(/\s+/).map((v) => ruleLen(v)).filter((v): v is number => v !== undefined);
  const copper: StackCopper[] = copperNums.map((n) => ({ name: doc.layers.get(n)?.name || undefined, thickness: thick[n - 1] ? mm(thick[n - 1]!) : undefined }));
  const diels = copperNums.length === 2 && isol.length ? [{ thickness: mm(isol[0]!) }] : [];
  applyStackLayers(pcbDoc, copper, diels);
  if (copperNums.length > 2) warnOnce('The layer stack\'s dielectrics left at the defaults (EAGLE\'s layer setup not read)');
  for (const [m, nm] of mechNames) pcbDoc.board.layerNames.set(mechLayer(m), nm);
  for (let i = 0; i < polygons.length; i++) repour(pcbDoc, i).apply();
  if (polygons.length && !opts.packages) warnings.push(`${polygons.length} polygon${polygons.length === 1 ? '' : 's'} poured with the board's rules (EAGLE's files keep no poured copper)`);
  for (const [k, c] of tally) warnings.push(`Left out: ${k} (${c})`);
  const footprints = footprintsFromBoard(pcbDoc);
  return { bytes: writePcbDoc(pcbDoc), name, footprints, warnings, signals: nets.map((n, i) => signalOf[i] ?? n), layers: new Map([...copperIdOf].map(([n, l]) => [l, n])), stats: { components: nComps, pads: nPads, vias: nVias, tracks: nTracks, nets: nets.length, layers: copperNums.length, pours: polygons.length } };
}

type Edge = { a: Vec2; b: Vec2; w?: number; arc?: { c: Vec2; r: number; sa: number; ea: number } };
type CL = typeof ClipperNS;
const CLIP: CL = (ClipperNS as unknown as { default?: CL }).default ?? ClipperNS;
/** Paths stroked as wide as they are (round ends), joined: their outlines. */
function strokeOutline(edges: Edge[]): Vec2[][] {
  const co = new CLIP.ClipperOffset(2, 250);
  const byWidth = new Map<number, ClipperNS.IntPoint[][]>();
  for (const e of edges) {
    const pts: Vec2[] = [e.a];
    if (e.arc) {
      const { c, r, sa, ea } = e.arc;
      const at = (a: number) => ({ x: c.x + r * Math.cos((a * Math.PI) / 180), y: c.y + r * Math.sin((a * Math.PI) / 180) });
      const fwd = Math.hypot(at(sa).x - e.a.x, at(sa).y - e.a.y) <= Math.hypot(at(ea).x - e.a.x, at(ea).y - e.a.y);
      const k = Math.max(2, Math.ceil(Math.abs(ea - sa) / 6));
      for (let j = 1; j < k; j++) pts.push(at(fwd ? sa + ((ea - sa) * j) / k : ea - ((ea - sa) * j) / k));
    }
    pts.push(e.b);
    const w = Math.round(e.w ?? 0);
    byWidth.set(w, [...(byWidth.get(w) ?? []), pts.map((p) => ({ X: Math.round(p.x), Y: Math.round(p.y) }))]);
  }
  const all: ClipperNS.IntPoint[][] = [];
  for (const [w, paths] of byWidth) {
    co.Clear();
    for (const p of paths) co.AddPath(p, CLIP.JoinType.jtRound, CLIP.EndType.etOpenRound);
    const out: ClipperNS.IntPoint[][] = [];
    co.Execute(out, w / 2);
    all.push(...out);
  }
  const c = new CLIP.Clipper();
  c.AddPaths(all, CLIP.PolyType.ptSubject, true);
  const res: ClipperNS.IntPoint[][] = [];
  c.Execute(CLIP.ClipType.ctUnion, res, CLIP.PolyFillType.pftNonZero, CLIP.PolyFillType.pftNonZero);
  return res.filter((r) => CLIP.Clipper.Orientation(r)).map((r) => r.map((q) => ({ x: q.X, y: q.Y })));
}

/** EAGLE's align → (horizontal 0 left … 2 right, vertical 0 bottom … 2 top). */
function alignOf(a: string | undefined): [number, number] {
  const s = (a ?? 'bottom-left').toLowerCase();
  if (s === 'center') return [1, 1];
  const [v, h] = s.split('-');
  return [h === 'left' ? 0 : h === 'right' ? 2 : 1, v === 'bottom' ? 0 : v === 'top' ? 2 : 1];
}

/** A library's packages (or those named) as footprints: each placed alone, read back as the library's. */
export function eagleFootprintLibrary(doc: EagleDoc, packages: { lib: ELib; pkg: string }[], names?: (lib: ELib, pkg: string) => string): { footprints: FootprintDef[]; warnings: string[] } {
  const r = convertEagleBrd(doc, 'Footprints', { packages, names });
  return { footprints: r.footprints, warnings: r.warnings.filter((w) => !/board outline|poured/i.test(w)) };
}
