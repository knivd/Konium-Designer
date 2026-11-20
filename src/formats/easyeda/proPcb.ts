/**
 * EasyEDA Pro boards as AD's: the copper stack (top, the inner layers enabled or in use with their
 * names and copper weights, bottom), silkscreens, masks, pastes, the board outline (Board Outline's
 * paths, slot outlines on the Multi-Layer the cut-outs) also on Mechanical 1, the assembly,
 * document, mechanical and footprint layers (component shape, marking, pin soldering …) on
 * mechanical layers by name; footprints placed from their documents (bottom ones mirrored, their
 * layers swapped) with pads by shape (rectangles, rounded, round and oval, polygon pads as copper
 * round a small pad), holes, slots, plating, mask and paste expansions, pad nets; vias, tracks
 * and arcs by net, filled areas (copper, slot regions as board cut-outs), keep-out regions,
 * teardrops, pours as polygons with their poured copper (else poured by the board's rules), text,
 * logos, design rules' defaults. EasyEDA Pro's unit is the mil, Y up as AD has it; the board's lower
 * left goes 1000 mil in from AD's sheet corner, AD's origin at EasyEDA's.
 */
import type { Vec2 } from '../../core/geom';
import { formatAltiumLength, mil, mm } from '../../core/units';
import { L, mechLayer, type LayerId } from '../../model/layers';
import type { PolyVertex } from '../../model/pcb';
import { footprintsFromBoard } from '../../model/pcbLib';
import { repour } from '../../model/pcbEdit';
import { newBoardRecord } from '../altium/board6';
import { assemblePcbDoc, applyStackLayers, type StackCopper, type StackDielectric } from '../altium/assemble';
import { encodeArc, encodePad, encodeRegion, encodeText, encodeTrack, encodeVia, layerToName, writePcbDoc, writeVertices, type PadFields } from '../altium/pcbdoc';
import type { FootprintDef } from '../altium/pcblib';
import type { PcbRawRecord } from '../altium/framing';
import { PropertyBag } from '../altium/props';
import { altiumFloat } from '../altium/pcbTransform';
import { newPolygonProps } from '../altium/polygonProps';
import { boardRules, uniqueIdFor } from '../kicad/board';
import { strokeTextWidth } from '../gerber/stroke';
import { nearestLoops, insidePoly } from './stdPcb';
import { proNames, type ProDoc, type ProProject, type Rec } from './proRead';

export interface ProPcbResult { bytes: Uint8Array; name: string; footprints: FootprintDef[]; warnings: string[]; stats: { components: number; pads: number; vias: number; tracks: number; nets: number; layers: number } }

const norm = (a: number) => ((a % 360) + 360) % 360;
const n = (v: unknown, d = 0): number => { const x = typeof v === 'number' ? v : v === null || v === undefined || v === '' ? NaN : Number(v); return Number.isFinite(x) ? x : d; };
const s = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const yes = (v: unknown) => v === true || v === 1 || v === '1' || v === 'yes' || v === 'true';
const isNum = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));

/* ── paths: EasyEDA Pro's polygon tokens as segments ── */

/** A segment of a contour: a line, or an arc of `sweep` degrees (anticlockwise positive). */
export interface Seg { a: Vec2; b: Vec2; sweep?: number }

/** One path (numbers and commands: L, ARC/CARC, C, R, CIRCLE) as segments. `fill`: a board fill's (its arcs' angles ten times over). */
export function pathSegs(path: unknown, fill = false): Seg[] {
  const t = Array.isArray(path) ? path : [];
  const segs: Seg[] = [];
  let cur: Vec2 | null = null, i = 0;
  const num = () => n(t[i++]);
  while (i < t.length) {
    if (isNum(t[i])) { cur = { x: num(), y: num() }; continue; }
    const cmd = s(t[i++]).toUpperCase();
    switch (cmd) {
      case 'L':
        while (i + 1 < t.length && isNum(t[i]) && isNum(t[i + 1])) { const b = { x: num(), y: num() }; if (cur && (cur.x !== b.x || cur.y !== b.y)) segs.push({ a: cur, b }); cur = b; }
        break;
      case 'ARC': case 'CARC': {
        let sw = num();
        const b = { x: num(), y: num() };
        // A board fill's arcs are written ten times over [est: only past a full turn]
        if (fill && Math.abs(sw) > 360) sw /= 10;
        if (cur) segs.push(Math.abs(sw) > 1e-6 ? { a: cur, b, sweep: sw } : { a: cur, b });
        cur = b;
        break;
      }
      case 'C': {
        const c1 = { x: num(), y: num() }, c2 = { x: num(), y: num() }, b = { x: num(), y: num() };
        if (cur) {
          let p = cur;
          for (let k = 1; k <= 12; k++) {
            const u = k / 12, v = 1 - u;
            const q = { x: v * v * v * cur.x + 3 * v * v * u * c1.x + 3 * v * u * u * c2.x + u * u * u * b.x, y: v * v * v * cur.y + 3 * v * v * u * c1.y + 3 * v * u * u * c2.y + u * u * u * b.y };
            segs.push({ a: p, b: q }); p = q;
          }
        }
        cur = b;
        break;
      }
      case 'R': {
        // Its top-left corner (x, y), w across and h down, turned about that corner; r the corners' radius
        const x = num(), y = num(), w = num(), h = num(), rot = num();
        const r = isNum(t[i]) ? Math.min(num(), Math.abs(w) / 2, Math.abs(h) / 2) : 0;
        const c = Math.cos((rot * Math.PI) / 180), sn = Math.sin((rot * Math.PI) / 180);
        const at = (dx: number, dy: number) => ({ x: x + dx * c - dy * sn, y: y + dx * sn + dy * c });
        const pts: Vec2[] = r > 0
          ? [at(r, 0), at(w - r, 0), at(w, -r), at(w, -h + r), at(w - r, -h), at(r, -h), at(0, -h + r), at(0, -r)]
          : [at(0, 0), at(w, 0), at(w, -h), at(0, -h)];
        // Clockwise round (Y up): its corners' arcs a quarter turn clockwise
        for (let k = 0; k < pts.length; k++) {
          const a = pts[k]!, b = pts[(k + 1) % pts.length]!;
          segs.push(r > 0 && k % 2 === 1 ? { a, b, sweep: -90 } : { a, b });
        }
        cur = null;
        break;
      }
      case 'CIRCLE': {
        const cx = num(), cy = num(), r = num();
        if (r > 0) { const a = { x: cx + r, y: cy }, b = { x: cx - r, y: cy }; segs.push({ a, b, sweep: 180 }, { a: b, b: a, sweep: 180 }); }
        cur = null;
        break;
      }
      default: if (!cmd) i++;
    }
  }
  return segs;
}
/** A complex path's contours (one path or several). */
export const contours = (path: unknown, fill = false): Seg[][] => {
  if (!Array.isArray(path) || !path.length) return [];
  return (Array.isArray(path[0]) ? path : [path]).map((p) => pathSegs(p, fill)).filter((c) => c.length);
};

/** An arc from a to b turning `sweep` degrees (anticlockwise positive): its centre, radius and AD's angles (anticlockwise, start to end). */
export function arcOf(a: Vec2, b: Vec2, sweep: number): { c: Vec2; r: number; start: number; end: number } | null {
  const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
  if (d < 1e-9 || Math.abs(sweep) < 1e-6) return null;
  const half = (sweep * Math.PI) / 360, h = d / 2;
  const k = Math.abs(Math.abs(sweep) - 180) < 1e-9 ? 0 : h / Math.tan(half);
  const c = { x: (a.x + b.x) / 2 - (dy / d) * k, y: (a.y + b.y) / 2 + (dx / d) * k };
  const r = Math.abs(h / Math.sin(half));
  const ang = (p: Vec2) => norm((Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI);
  return sweep > 0 ? { c, r, start: ang(a), end: ang(b) } : { c, r, start: ang(b), end: ang(a) };
}
/** A contour's points (arcs stepped). */
export function ringOf(segs: Seg[], step = 6): Vec2[] {
  const out: Vec2[] = [];
  for (const g of segs) {
    if (!out.length) out.push(g.a);
    const arc = g.sweep ? arcOf(g.a, g.b, g.sweep) : null;
    if (arc) {
      const a0 = (Math.atan2(g.a.y - arc.c.y, g.a.x - arc.c.x) * 180) / Math.PI;
      const k = Math.max(2, Math.ceil(Math.abs(g.sweep!) / step));
      for (let i = 1; i < k; i++) { const t = ((a0 + (g.sweep! * i) / k) * Math.PI) / 180; out.push({ x: arc.c.x + arc.r * Math.cos(t), y: arc.c.y + arc.r * Math.sin(t) }); }
    }
    out.push(g.b);
  }
  if (out.length > 2 && Math.hypot(out[0]!.x - out[out.length - 1]!.x, out[0]!.y - out[out.length - 1]!.y) < 1e-6) out.pop();
  return out;
}
const area = (r: Vec2[]) => r.reduce((a, p, i) => { const q = r[(i + 1) % r.length]!; return a + p.x * q.y - q.x * p.y; }, 0) / 2;
/** Rings nested: each outline with the holes inside it. */
export function nestRings(rings: Vec2[][]): { outline: Vec2[]; holes: Vec2[][] }[] {
  const sorted = rings.filter((r) => r.length >= 3).map((r) => ({ r, a: Math.abs(area(r)) })).sort((x, y) => y.a - x.a);
  const out: { outline: Vec2[]; holes: Vec2[][] }[] = [];
  for (const { r } of sorted) {
    const host = out.find((o) => insidePoly(r[0]!, o.outline) && !o.holes.some((h) => insidePoly(r[0]!, h)));
    if (host) host.holes.push(r); else out.push({ outline: r, holes: [] });
  }
  return out;
}

/* ── layers ── */

/** EasyEDA Pro's documentation and footprint layers on AD's mechanical layers, by number and name. */
const MECH: Record<number, [number, string]> = {
  11: [1, 'Board Outline'], 13: [2, 'Document'], 14: [3, 'Mechanical'], 48: [4, 'Component Shape'], 50: [5, 'Pin Soldering'], 49: [6, 'Component Marking'],
  51: [7, 'Pin Floating'], 47: [8, 'Hole'], 52: [9, 'Component Model'], 58: [10, 'Top Stiffener'], 59: [11, 'Bottom Stiffener'], 9: [13, 'Top Assembly'], 10: [14, 'Bottom Assembly'],
};
const FIXED: Record<number, LayerId> = { 3: L.TOP_OVERLAY, 4: L.BOTTOM_OVERLAY, 5: L.TOP_SOLDER, 6: L.BOTTOM_SOLDER, 7: L.TOP_PASTE, 8: L.BOTTOM_PASTE, 56: L.DRILL_DRAWING };
const FLIP: Record<number, number> = { 1: 2, 2: 1, 3: 4, 4: 3, 5: 6, 6: 5, 7: 8, 8: 7, 9: 10, 10: 9, 58: 59, 59: 58 };
const SKIP = new Set([53, 54, 55, 57]);
const isInner = (id: number) => id >= 15 && id <= 46;
const BACK = new Set([2, 4, 6, 8, 10]);
/** AD's text height for EasyEDA's font size: its capitals 0.7 of it, its characters 0.6 of it apart [est: as AD's stroke font spaces them]. */
const TEXT_H = 0.7;

/** Where a record keeps its layer. */
const layerIdOf = (r: Rec): number | undefined => {
  switch (r[0]) {
    case 'PAD': case 'LINE': case 'ARC': case 'CARC': case 'POLY': case 'FILL': case 'POUR': return n(r[4]);
    case 'STRING': case 'REGION': case 'IMAGE': case 'TEARDROP': case 'DIMENSION': return n(r[3]);
    case 'ATTR': return n(r[4]);
    default: return undefined;
  }
};

/* ── text ── */

/** Where AD's text (its lower left) goes for EasyEDA's anchor (1–9: left, centre, right × top, middle, bottom), the text as wide as AD draws it. */
function textCorner(at: Vec2, code: number, text: string, h: number, rot: number, mirrored: boolean, trueType = false): Vec2 {
  const c = code >= 1 && code <= 9 ? code : 3;
  const hx = c <= 3 ? 0 : c <= 6 ? 0.5 : 1, vy = c % 3 === 1 ? 1 : c % 3 === 2 ? 0.5 : 0;
  const lines = text.split('\n');
  // TrueType: h is a character's width [est], the height about 1.3 of it
  const w = trueType ? Math.max(...lines.map((l) => l.length)) * h : strokeTextWidth(text, h), H = trueType ? h * 1.3 * lines.length : h * (lines.length * 1.4 - 0.4);
  let dx = -hx * w;
  const dy = -vy * H;
  if (mirrored) dx = -dx;
  const cr = Math.cos((rot * Math.PI) / 180), sr = Math.sin((rot * Math.PI) / 180);
  return { x: at.x + dx * cr - dy * sr, y: at.y + dx * sr + dy * cr };
}

/** "={Key}" templates filled from the attributes (an unknown key left as it is). */
export function proValue(v: string, get: (k: string) => string | undefined): string {
  let out = v;
  for (let k = 0; k < 4 && out.startsWith('={'); k++) out = out.slice(1).replace(/\{([^{}]*)\}/g, (m, key: string) => get(key) ?? m);
  return out.replace(/℃/g, '°C');
}

/* ── the board ── */

export function convertProPcb(p: ProProject, pcb: ProDoc, name: string): ProPcbResult {
  const warnings: string[] = [];
  const warned = new Set<string>();
  const warnOnce = (w: string) => { if (!warned.has(w)) { warned.add(w); warnings.push(w); } };
  const tally = new Map<string, number>();
  const skip = (what: string) => tally.set(what, (tally.get(what) ?? 0) + 1);
  // The 3D shell and ratline layers: nothing for AD
  const skipLayer = (lid: number) => { if (!SKIP.has(lid)) skipLayer(lid); };
  const recs = pcb.recs;

  /* Components' footprints and attributes */
  const childAttrs = new Map<string, Rec[]>();
  for (const r of recs) if (r[0] === 'ATTR' && s(r[3])) { const k = s(r[3]); if (!childAttrs.has(k)) childAttrs.set(k, []); childAttrs.get(k)!.push(r); }
  const attrOf = (id: string, key: string) => childAttrs.get(id)?.find((a) => s(a[7]) === key);
  const deviceOf = (c: Rec) => p.devices.get(s(attrOf(s(c[1]), 'Device')?.[8]) || s((c[7] as Record<string, unknown> | undefined)?.Device));
  const footprintOf = (c: Rec): ProDoc | undefined => {
    const id = s(attrOf(s(c[1]), 'Footprint')?.[8]) || s((c[7] as Record<string, unknown> | undefined)?.Footprint) || s(deviceOf(c)?.attributes.Footprint);
    return p.footprints.get(id) ?? [...p.footprints.values()].find((f) => f.title === id);
  };
  const comps = recs.filter((r) => r[0] === 'COMPONENT');

  /* Layers: copper top, the inner ones enabled or in use, bottom */
  const layerRow = new Map<number, Rec>();
  for (const r of recs) if (r[0] === 'LAYER') layerRow.set(n(r[1]), r);
  const used = new Set<number>();
  const see = (rs: Rec[]) => { for (const r of rs) { const l = layerIdOf(r); if (l !== undefined) used.add(l); } };
  see(recs);
  for (const c of comps) { const f = footprintOf(c); if (f) see(f.recs); }
  const inner = [...new Set([...layerRow.keys()].filter((id) => isInner(id) && ((n(layerRow.get(id)![4]) & 1) || used.has(id))).concat([...used].filter(isInner)))].sort((a, b) => a - b).slice(0, 30);
  if (inner.some((id) => s(layerRow.get(id)?.[2]).toUpperCase() === 'PLANE')) warnOnce('Inner plane layers read as signal layers (their copper as drawn)');
  const copperOrder = [1, ...inner, 2];
  const copperOf = new Map<number, LayerId>(copperOrder.map((id, i) => [id, (i === 0 ? L.TOP : i === copperOrder.length - 1 ? L.BOTTOM : (L.MID1 + i - 1)) as LayerId]));
  const isCopper = (id: number) => copperOf.has(id);
  const mechNames = new Map<number, string>();
  let custom = 15;
  const customMech = new Map<number, number>();
  const layerOf = (id: number): LayerId | null => {
    const c = copperOf.get(id);
    if (c !== undefined) return c;
    if (FIXED[id] !== undefined) return FIXED[id]!;
    if (id === 12) return L.MULTI;
    let m = MECH[id];
    if (!m && id >= 71 && id <= 100) {
      if (!customMech.has(id)) customMech.set(id, custom <= 32 ? custom++ : 0);
      const k = customMech.get(id)!;
      if (k) m = [k, s(layerRow.get(id)?.[3]) || `Custom ${id - 70}`];
    }
    if (m) { if (!mechNames.has(m[0])) mechNames.set(m[0], s(layerRow.get(id)?.[3]) || m[1]); return mechLayer(m[0]); }
    return null;
  };

  /* Coordinates: the content's lower left 1000 mil in */
  let x0 = Infinity, y0 = Infinity;
  const seePt = (x: unknown, y: unknown) => { const a = n(x, NaN), b = n(y, NaN); if (Number.isFinite(a) && Number.isFinite(b)) { if (a < x0) x0 = a; if (b < y0) y0 = b; } };
  for (const r of recs) {
    switch (r[0]) {
      case 'LINE': case 'ARC': case 'CARC': seePt(r[5], r[6]); seePt(r[7], r[8]); break;
      case 'VIA': case 'COMPONENT': seePt(r[r[0] === 'VIA' ? 5 : 4], r[r[0] === 'VIA' ? 6 : 5]); break;
      case 'PAD': seePt(r[6], r[7]); break;
      case 'POLY': case 'FILL': case 'POUR': case 'REGION': for (const c of contours(r[r[0] === 'POLY' ? 6 : r[0] === 'REGION' ? 6 : r[0] === 'POUR' ? 8 : 7])) for (const g of c) seePt(g.a.x, g.a.y); break;
      default:
    }
  }
  if (!Number.isFinite(x0)) { x0 = 0; y0 = 0; }
  const P = (v: Vec2): Vec2 => ({ x: Math.round(mil(1000) + (v.x - x0) * 10000), y: Math.round(mil(1000) + (v.y - y0) * 10000) });
  const len = (v: number) => Math.max(0, Math.round(v * 10000));

  /* Nets */
  const nets: string[] = [];
  const netIndex = new Map<string, number>();
  const netOf = (name: unknown): number | undefined => {
    const k = s(name);
    if (!k) return undefined;
    if (!netIndex.has(k)) { netIndex.set(k, nets.length); nets.push(k); }
    return netIndex.get(k);
  };
  for (const r of recs) if (r[0] === 'NET' && s(r[1])) netOf(r[1]);
  const padNets = new Map<string, Map<string, string>>();
  const padIdNets = new Map<string, string>();
  for (const r of recs) if (r[0] === 'PAD_NET') {
    const c = s(r[1]);
    if (!padNets.has(c)) padNets.set(c, new Map());
    padNets.get(c)!.set(s(r[2]), s(r[3]));
    if (s(r[4])) padIdNets.set(`${c}\u0000${s(r[4])}`, s(r[3]));
  }

  const compBags: PropertyBag[] = [];
  const pads: PcbRawRecord[] = [], tracks: PcbRawRecord[] = [], arcs: PcbRawRecord[] = [], vias: PcbRawRecord[] = [], regions: PcbRawRecord[] = [], texts: PcbRawRecord[] = [];
  const polygons: PropertyBag[] = [];
  const outlineEdges: { a: Vec2; b: Vec2; arc?: { c: Vec2; r: number; sa: number; ea: number } }[] = [];
  const pourOrder: { index: number; order: number; poured: boolean }[] = [];
  const pourIndex = new Map<string, number>();
  let nTracks = 0, nVias = 0;

  /** A placement: local points to the board's (a bottom one mirrored top to bottom first), layers swapped. */
  interface Place { pt: (v: Vec2) => Vec2; mirror: boolean; rot: number; owner?: number; id?: string; layer: (id: number) => number }
  const free: Place = { pt: P, mirror: false, rot: 0, layer: (id) => id };
  const placeOf = (x: number, y: number, rot: number, bottom: boolean, owner: number, id: string): Place => {
    const c = Math.cos((rot * Math.PI) / 180), sn = Math.sin((rot * Math.PI) / 180);
    return { pt: (v) => { const vy = bottom ? -v.y : v.y; return P({ x: x + v.x * c - vy * sn, y: y + v.x * sn + vy * c }); }, mirror: bottom, rot, owner, id, layer: (l) => (bottom ? FLIP[l] ?? l : l) };
  };

  /** Segments stroked on a layer: tracks and arcs (and the board's outline on Board Outline and the Multi-Layer). */
  const stroke = (segs: Seg[], lid: number, width: number, net: number | undefined, pl: Place) => {
    const layer = lid === 12 ? mechLayer(1) : layerOf(lid);
    if (layer === null) { skipLayer(lid); return; }
    const w = Math.max(1, len(width));
    for (const g of segs) {
      const a = pl.pt(g.a), b = pl.pt(g.b);
      const sw = g.sweep ? (pl.mirror ? -g.sweep : g.sweep) : 0;
      const arc = sw ? arcOf(a, b, sw) : null;
      if (arc) arcs.push(encodeArc({ layer, c: { x: Math.round(arc.c.x), y: Math.round(arc.c.y) }, r: Math.round(arc.r), start: arc.start, end: arc.end, width: w, net, component: pl.owner }));
      else tracks.push(encodeTrack({ layer, a, b, width: w, net, component: pl.owner }));
      nTracks++;
      if (lid === 11 || lid === 12) outlineEdges.push(arc ? { a, b, arc: { c: arc.c, r: arc.r, sa: arc.start, ea: arc.end < arc.start ? arc.end + 360 : arc.end } } : { a, b });
    }
  };
  /** A complex path filled on a layer: regions (with their holes). */
  const fillRegions = (path: unknown, lid: number, net: number | undefined, pl: Place, opts: { fill?: boolean; polygon?: number; scale?: number } = {}) => {
    const sc = opts.scale ?? 1;
    const rings = contours(path, opts.fill).map((c) => ringOf(c.map((g) => ({ ...g, a: { x: g.a.x * sc, y: g.a.y * sc }, b: { x: g.b.x * sc, y: g.b.y * sc } }))).map(pl.pt));
    if (lid === 12 || lid === 11) {
      for (const o of nestRings(rings)) if (lid === 12) regions.push(encodeRegion({ layer: L.MULTI, outline: o.outline, boardCutout: true }));
      if (lid === 11) for (const c of contours(path, opts.fill)) stroke(c, 11, 0.1, undefined, pl);
      return;
    }
    const layer = layerOf(lid);
    if (layer === null) { skipLayer(lid); return; }
    for (const o of nestRings(rings)) regions.push(encodeRegion({ layer, outline: o.outline, holes: o.holes, net: isCopper(lid) ? net : undefined, polygon: opts.polygon, component: pl.owner }));
  };

  /** A pad (on the board, or a footprint's placed). */
  const padOf = (r: Rec, pl: Place, net: number | undefined) => {
    const lid0 = n(r[4]);
    const multi = lid0 === 12;
    const lid = multi ? 12 : pl.layer(lid0);
    const layer: LayerId | null = multi ? L.MULTI : copperOf.get(lid) ?? null;
    if (layer === null) { skip('pad off copper'); return; }
    const at0 = { x: n(r[6]), y: n(r[7]) };
    const at = pl.pt(at0);
    const phi = n(r[8]);
    // Reflected top to bottom: AD's pad turned half round more (its mirror is left to right)
    const rot = norm(pl.mirror ? pl.rot + 180 - phi : pl.rot + phi);
    const sh = (Array.isArray(r[10]) ? r[10] : []) as unknown[];
    const kind = s(sh[0]).toUpperCase();
    let w = len(n(sh[1])), h = len(n(sh[2]));
    let shape: PadFields['shape'] = kind === 'RECT' ? 'rect' : 'round';
    let cornerPct: number | undefined;
    if (kind === 'RECT' && n(sh[3]) > 0) { shape = 'roundrect'; cornerPct = Math.min(100, n(sh[3])); }
    if (kind === 'NGON') { w = h = len(n(sh[1])); shape = n(sh[2]) === 8 ? 'octagon' : 'round'; }
    const hole = (Array.isArray(r[9]) ? r[9] : null) as unknown[] | null;
    let drill = 0;
    let slot: PadFields['slot'];
    if (hole) {
      const hw = len(n(hole[1])), hh = len(n(hole[2], n(hole[1])));
      const ht = s(hole[0]).toUpperCase();
      drill = Math.min(hw, hh) || Math.max(hw, hh);
      if (drill > 0 && Math.abs(hw - hh) > 1 && (ht === 'SLOT' || ht === 'RECT' || ht === 'ROUND')) slot = { length: Math.max(hw, hh), rotation: norm((hw >= hh ? 0 : 90) + n(r[14]) * (pl.mirror ? -1 : 1)) };
    }
    if (kind === 'POLY' || kind === 'POLYGON') {
      // AD's pads have no polygon: the outline as copper, a pad within it
      const rings = contours(sh[1]).map((c) => ringOf(c).map(pl.pt));
      const cu = layer === L.MULTI ? [L.TOP, L.BOTTOM] as LayerId[] : [layer];
      const nested = nestRings(rings);
      for (const cl of cu) for (const o of nested) regions.push(encodeRegion({ layer: cl, outline: o.outline, holes: o.holes, net, component: pl.owner }));
      const bb = nested[0]?.outline ?? [];
      const span = bb.length ? Math.min(Math.max(...bb.map((q) => q.x)) - Math.min(...bb.map((q) => q.x)), Math.max(...bb.map((q) => q.y)) - Math.min(...bb.map((q) => q.y))) : mil(10);
      w = h = Math.max(mil(2), Math.round(span * 0.4));
      if (drill) w = h = Math.max(w, drill + mil(4));
      shape = 'round';
    }
    if (w <= 0 || h <= 0) {
      if (!drill) { skip('pad without copper'); return; }
      w = h = drill;   // a bare hole
    }
    const mask = n(r[layer === L.BOTTOM ? 18 : 17], NaN);
    const paste = n(r[layer === L.BOTTOM ? 20 : 19], NaN);
    pads.push(encodePad({ name: s(r[5]), layer, at, w, h, shape, cornerPct, rotation: rot, hole: drill || undefined, plated: drill ? yes(r[15]) || r[15] === undefined : undefined,
      slot, net, component: pl.owner,
      solderExpansion: Number.isFinite(mask) && mask > -999 ? len(mask) : undefined,
      pasteExpansion: Number.isFinite(paste) && layer !== L.MULTI ? (paste <= -999 ? -Math.max(w, h) : len(paste) || undefined) : undefined }));
  };

  /** A text: the stroke font for EasyEDA's own (its capitals 0.7 of its size), else its TrueType font at its size; placed by its anchor. */
  const textRec = (text: string, layer: LayerId, at0: Vec2, size: number, strokeW: number, rot: number, origin: number, mirrored: boolean, font: string,
    style: { bold?: boolean; italic?: boolean; inverted?: boolean }, owner?: number, isDesignator = false, isComment = false): PcbRawRecord => {
    const tt = !!font && !/^default$/i.test(font);
    const h = Math.max(mil(10), len(size * (tt ? 1 : TEXT_H)));
    const at = textCorner(at0, origin, text, tt ? len(size * 0.55) : h, rot, mirrored, tt);
    return encodeText({ layer, at: { x: Math.round(at.x), y: Math.round(at.y) }, height: h, text, rotation: rot, strokeWidth: Math.max(mil(1), len(strokeW)), mirrored, component: owner,
      isDesignator, isComment, trueType: tt ? { name: font, ...style } : undefined });
  };

  /** One primitive (the board's or a footprint's placed). */
  const prim = (r: Rec, pl: Place, inFootprint: boolean): void => {
    const owner = pl.owner;
    switch (r[0]) {
      case 'LINE': case 'ARC': case 'CARC': {
        const lid = pl.layer(n(r[4]));
        const a = { x: n(r[5]), y: n(r[6]) }, b = { x: n(r[7]), y: n(r[8]) };
        const sweep = r[0] === 'LINE' ? 0 : n(r[9]);
        const width = n(r[r[0] === 'LINE' ? 9 : 10]);
        const net = !inFootprint && isCopper(lid) ? netOf(r[3]) : undefined;
        stroke([sweep ? { a, b, sweep } : { a, b }], lid, width, net, pl);
        return;
      }
      case 'POLY': {
        const lid = pl.layer(n(r[4]));
        for (const c of contours(r[6])) {
          const closed = c.length > 1 && Math.hypot(c[0]!.a.x - c[c.length - 1]!.b.x, c[0]!.a.y - c[c.length - 1]!.b.y) < 1e-6;
          if (lid === 12 && closed) { const ring = ringOf(c).map(pl.pt); if (ring.length >= 3) regions.push(encodeRegion({ layer: L.MULTI, outline: ring, boardCutout: true })); }
          else stroke(c, lid, n(r[5]), !inFootprint && isCopper(lid) ? netOf(r[3]) : undefined, pl);
        }
        return;
      }
      case 'FILL': {
        const lid = pl.layer(n(r[4]));
        fillRegions(r[7], lid, !inFootprint ? netOf(r[3]) : undefined, pl, { fill: !inFootprint });
        return;
      }
      case 'TEARDROP': {
        const lid = pl.layer(n(r[3]));
        if (isCopper(lid)) fillRegions([r[4]], lid, netOf(r[2]), pl);
        return;
      }
      case 'REGION': {
        const lid = pl.layer(n(r[3]));
        const flags = (Array.isArray(r[5]) ? r[5] : []).map((x) => n(x));
        if (!flags.length) { skip('rule areas'); return; }
        if (flags.every((f) => f === 2)) { skip('component keep-outs'); return; }
        const layer = isCopper(lid) ? copperOf.get(lid)! : L.KEEPOUT;
        for (const o of nestRings(contours(r[6]).map((c) => ringOf(c).map(pl.pt)))) {
          const rec = encodeRegion({ layer, outline: o.outline, holes: o.holes, component: owner });
          rec.subs[0]![2] = 2;
          regions.push(rec);
        }
        return;
      }
      case 'VIA': {
        const at = pl.pt({ x: n(r[5]), y: n(r[6]) }), hole = len(n(r[7])), d = len(n(r[8]));
        if (owner !== undefined) { pads.push(encodePad({ name: '', layer: L.MULTI, at, w: Math.max(d, hole + 1), h: Math.max(d, hole + 1), shape: 'round', hole, component: owner })); return; }
        vias.push(encodeVia({ at, diameter: Math.max(d, hole + 1), hole, net: netOf(r[3]) })); nVias++;
        return;
      }
      case 'PAD': {
        const net = owner !== undefined ? netOf(padIdNets.get(`${pl.id}\u0000${s(r[1])}`) ?? padNets.get(pl.id!)?.get(s(r[5]))) : netOf(r[3]);
        padOf(r, pl, net);
        return;
      }
      case 'STRING': {
        const lid = pl.layer(n(r[3]));
        const layer = lid === 12 ? null : layerOf(lid);
        const text = s(r[6]);
        if (layer === null || !text) { if (text) skipLayer(lid); return; }
        const mirrored = BACK.has(lid) || (layer === L.BOTTOM);
        const rot = norm(pl.mirror ? pl.rot + 180 - n(r[13]) : pl.rot + n(r[13]));
        texts.push(textRec(text, layer, pl.pt({ x: n(r[4]), y: n(r[5]) }), n(r[8]), n(r[9]), rot, n(r[12], 3), mirrored, s(r[7]), { bold: yes(r[10]), italic: yes(r[11]), inverted: yes(r[14]) }, owner));
        return;
      }
      case 'IMAGE': {
        const lid = pl.layer(n(r[3]));
        const layer = layerOf(lid);
        if (layer === null) { skipLayer(lid); return; }
        // Its outlines scaled into its box, the box's top left at (x, y), turned about it; mirrored on the bottom (or when asked)
        const all = (Array.isArray(r[10]) ? r[10] : []).flatMap((cp) => contours(cp)).map((c) => ringOf(c));
        const pts = all.flat();
        if (!pts.length) return;
        const bx0 = Math.min(...pts.map((q) => q.x)), bx1 = Math.max(...pts.map((q) => q.x)), by0 = Math.min(...pts.map((q) => q.y)), by1 = Math.max(...pts.map((q) => q.y));
        const sx = n(r[6]) / Math.max(1e-9, bx1 - bx0), sy = n(r[7]) / Math.max(1e-9, by1 - by0);
        const x = n(r[4]), y = n(r[5]), ang = (n(r[8]) * Math.PI) / 180;
        const back = BACK.has(lid), mirror = yes(r[9]);
        const map = (q: Vec2) => {
          let dx = (q.x - bx0) * sx, dy = (q.y - by1) * sy;
          const c = Math.cos(ang), sn = Math.sin(ang);
          [dx, dy] = [dx * c - dy * sn, dx * sn + dy * c];
          // Mirrored about its corner: top to bottom on the bottom side, left to right when asked on the top
          if (back !== mirror) { if (back) dy = -dy; else dx = -dx; }
          return pl.pt({ x: x + dx, y: y + dy });
        };
        for (const o of nestRings(all.map((rg) => rg.map(map)))) regions.push(encodeRegion({ layer, outline: o.outline, holes: o.holes, component: owner }));
        return;
      }
      case 'POUR': pourOf(r); return;
      case 'DIMENSION': {
        const layer = layerOf(pl.layer(n(r[3])));
        const pts = (Array.isArray(r[8]) ? r[8] : []).map((v) => n(v));
        if (layer === null || pts.length < 4) return;
        const w = Math.max(1, len(n(r[5], 6)));
        for (let k = 2; k + 1 < pts.length; k += 2) tracks.push(encodeTrack({ layer, a: pl.pt({ x: pts[k - 2]!, y: pts[k - 1]! }), b: pl.pt({ x: pts[k]!, y: pts[k + 1]! }), width: w, component: owner }));
        return;
      }
      default:
    }
  };

  /** A pour: a polygon, its poured copper (EasyEDA keeps it at a tenth of the board's scale) as its regions and spokes. */
  function pourOf(r: Rec): void {
    const lid = n(r[4]);
    const layer = copperOf.get(lid);
    if (layer === undefined) { skip('pour off copper'); return; }
    const cs = contours(r[8]);
    if (!cs.length) return;
    const outline = ringOf(cs[0]!).map(P);
    if (outline.length < 3) return;
    const net = netOf(r[3]);
    const index = polygons.length;
    const bag = newPolygonProps(layerToName(layer), net ?? 0xffff, s(r[6]) || `${s(r[3]) || 'No Net'}_${index + 1}`, index);
    writeVertices(bag, outline.map((q): PolyVertex => ({ p: q })));
    bag.set('TRACKWIDTH', formatAltiumLength(Math.max(mil(1), len(n(r[5])))));
    bag.set('REMOVEDEAD', yes(r[10]) ? 'FALSE' : 'TRUE');
    const fill = Array.isArray(r[9]) ? s((r[9] as unknown[])[0]).toUpperCase() : 'SOLID';
    if (fill === 'LINE' || fill === 'GRID') bag.set('HATCHSTYLE', '90Degree');
    polygons.push(bag);
    pourIndex.set(s(r[1]), index);
    for (const hole of cs.slice(1)) { const ring = ringOf(hole).map(P); if (ring.length >= 3) regions.push(encodeRegion({ layer, outline: ring, kind: 1 })); }
    pourOrder.push({ index, order: n(r[7], index), poured: false });
  }

  /* ── the board's primitives, then the footprints ── */
  for (const r of recs) if (r[0] !== 'ATTR' && r[0] !== 'COMPONENT') prim(r, free, false);

  const names = proNames(p);
  let nComps = 0;
  for (const c of comps) {
    const id = s(c[1]);
    const f = footprintOf(c);
    if (!f) { skip('parts without a footprint'); continue; }
    const bottom = n(c[3]) === 2;
    const x = n(c[4]), y = n(c[5]), rot = norm(n(c[6]));
    const dev = deviceOf(c);
    const inst = (c[7] ?? {}) as Record<string, unknown>;
    const get = (k: string): string | undefined => { const a = attrOf(id, k); if (a && s(a[8])) return s(a[8]); if (inst[k] !== undefined && s(inst[k])) return s(inst[k]); return dev?.attributes[k] || undefined; };
    const des = attrOf(id, 'Designator');
    const designator = s(des?.[8]) || `${(dev?.attributes.Designator ?? 'U?').replace(/\?$/, '')}?`;
    const pattern = names.footprints.get(f.uuid) ?? f.title;
    const ci = compBags.length;
    const pos = P({ x, y });
    const value = proValue(get('Name') || get('Value') || '', get);
    const uid = s(inst['Unique ID']) || s(attrOf(id, 'Unique ID')?.[8]);
    // A bottom part: reflected top to bottom, then turned, as AD places one
    compBags.push(PropertyBag.from({
      LAYER: bottom ? 'BOTTOM' : 'TOP', PATTERN: pattern, SOURCEDESIGNATOR: designator, SOURCEFOOTPRINTLIBRARY: `${name}.PcbLib`,
      X: formatAltiumLength(pos.x), Y: formatAltiumLength(pos.y), ROTATION: altiumFloat(rot),
      NAMEON: des && yes(des[10]) && des[5] !== null ? 'TRUE' : 'FALSE', COMMENTON: 'FALSE', LOCKED: yes(c[8]) ? 'TRUE' : 'FALSE', COMPONENTKIND: 0,
      SOURCELIBREFERENCE: names.symbols.get(s(dev?.attributes.Symbol)) || dev?.title || '', SOURCEUNIQUEID: uid ? `\\${uniqueIdFor(`easyedapro:${uid}`)}` : '',
      FOOTPRINTDESCRIPTION: '',
    }));
    const pl = placeOf(x, y, rot, bottom, ci, id);
    for (const r of f.recs) if (r[0] !== 'ATTR') prim(r, pl, true);
    // Designator and comment where the board shows them
    const textAt = (a: Rec | undefined, text: string, kind: 'des' | 'com') => {
      const placed = a && a[5] !== null && a[5] !== undefined;
      const lid = a ? n(a[4], bottom ? 4 : 3) : bottom ? 4 : 3;
      const layer = layerOf(lid) ?? (bottom ? L.BOTTOM_OVERLAY : L.TOP_OVERLAY);
      const at = placed ? P({ x: n(a![5]), y: n(a![6]) }) : pos;
      texts.push(textRec(text, layer, at, n(a?.[12], 45), n(a?.[13], 6), norm(n(a?.[17])), placed ? n(a![16], 3) : 3, BACK.has(lid), s(a?.[11]), { bold: yes(a?.[14]), italic: yes(a?.[15]) }, ci,
        kind === 'des', kind === 'com'));
    };
    textAt(des, designator, 'des');
    textAt(attrOf(id, 'Value') ?? attrOf(id, 'Name'), value || pattern, 'com');
    nComps++;
  }

  /* ── the poured copper ── */
  const poured = [...recs.filter((r) => r[0] === 'POURED'), ...(p.poured.get(pcb.uuid) ?? [])];
  for (const r of poured) {
    const index = pourIndex.get(s(r[2]));
    if (index === undefined) continue;
    const layer = copperOf.get(n(recs.find((q) => q[0] === 'POUR' && s(q[1]) === s(r[2]))?.[4]));
    if (layer === undefined) continue;
    const pourNet = netOf(recs.find((q) => q[0] === 'POUR' && s(q[1]) === s(r[2]))?.[3]);
    if (yes(r[4])) {
      const rings = contours(r[5]).map((c) => ringOf(c.map((g) => ({ ...g, a: { x: g.a.x * 10, y: g.a.y * 10 }, b: { x: g.b.x * 10, y: g.b.y * 10 } }))).map(P));
      for (const o of nestRings(rings)) regions.push(encodeRegion({ layer, outline: o.outline, holes: o.holes, net: pourNet, polygon: index }));
    } else {
      const w = Math.max(mil(1), len(n(r[3]) * 10));
      for (const c of contours(r[5])) for (const g of c) tracks.push(encodeTrack({ layer, a: P({ x: g.a.x * 10, y: g.a.y * 10 }), b: P({ x: g.b.x * 10, y: g.b.y * 10 }), width: w, net: pourNet, polygon: index }));
    }
    const o = pourOrder.find((q) => q.index === index);
    if (o) o.poured = true;
  }

  /* ── the board shape: the loops of Board Outline (and the Multi-Layer's slots), the largest the board, the rest cut-outs ── */
  let loops: PolyVertex[][] = [];
  for (const tol of [mm(0.01), mm(0.1), mm(1.5), mm(3)]) {
    loops = nearestLoops(outlineEdges, tol).filter((l) => l.length >= 2);
    const usedEdges = loops.reduce((k, l) => k + l.length, 0);
    if (loops.length && usedEdges >= outlineEdges.length * 0.6) break;
  }
  const loopArea = (vs: PolyVertex[]) => Math.abs(vs.reduce((a, v, i) => { const q = vs[(i + 1) % vs.length]!.p; return a + v.p.x * q.y - q.x * v.p.y; }, 0));
  let outline: PolyVertex[];
  if (loops.length) {
    loops.sort((a, b) => loopArea(b) - loopArea(a));
    outline = loops[0]!;
    for (const cut of loops.slice(1)) {
      const pts = cut.map((v) => v.p);
      if (pts.length >= 3) regions.push(encodeRegion({ layer: L.MULTI, outline: pts, boardCutout: true }));
    }
  } else {
    if (nComps || nTracks) warnings.push('No board outline (Board Outline layer): the board shape is drawn round the contents');
    const all = [...compBags.map((b) => ({ x: Number.parseFloat(b.get('X') ?? '0') * 10000, y: Number.parseFloat(b.get('Y') ?? '0') * 10000 }))];
    const xs = all.map((q) => q.x), ys = all.map((q) => q.y);
    const lo = { x: Math.min(mil(1000), ...xs) - mil(200), y: Math.min(mil(1000), ...ys) - mil(200) }, hi = { x: Math.max(mil(1400), ...xs) + mil(200), y: Math.max(mil(1300), ...ys) + mil(200) };
    outline = [{ p: lo }, { p: { x: hi.x, y: lo.y } }, { p: hi }, { p: { x: lo.x, y: hi.y } }];
  }
  const xs = outline.map((v) => v.p.x), ys = outline.map((v) => v.p.y);
  const board = newBoardRecord({ fileName: `${name}.PcbDoc`, origin: P({ x: 0, y: 0 }), outline,
    sheet: { x: 0, y: 0, width: Math.max(...xs) + mil(2000), height: Math.max(...ys) + mil(2000) }, mechanical: [1, 13, 14, ...mechNames.keys()] });
  for (const [m, nm] of mechNames) board.set(`LAYER${mechLayer(m)}NAME`, nm);

  pourOrder.sort((a, b) => a.order - b.order || a.index - b.index).forEach((o, i) => polygons[o.index]!.set('POURINDEX', String(i)));

  /* The design rules' defaults (mil, whatever unit they're labelled with) */
  const rule = (cat: string) => recs.find((r) => r[0] === 'RULE' && s(r[1]) === cat && n(r[3]) === 1) ?? recs.find((r) => r[0] === 'RULE' && s(r[1]) === cat);
  const toMm = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) * 0.0254 : undefined);
  const safe = rule('1')?.[4] as unknown[] | undefined;
  const matrix = Array.isArray(safe?.[1]) ? safe![1] as unknown[][] : undefined;
  const track = rule('3')?.[4] as unknown[] | undefined;
  const via = rule('5')?.[4] as unknown[] | undefined;
  const { rules, classes } = boardRules({ clearance: toMm(matrix?.[0]?.[0]), trackWidth: toMm(Array.isArray(track) && !Array.isArray(track[1]) && typeof track[1] !== 'object' ? track[2] : undefined),
    minTrack: toMm(Array.isArray(track) && typeof track[1] !== 'object' ? track[1] : undefined),
    viaDiameter: toMm(via?.[2]), viaDrill: toMm(via?.[5]), classes: [] }, nets, nets);

  const pcbDoc = assemblePcbDoc({ board, nets, comps: compBags, polygons, pads, tracks, vias, arcs, texts, regions, rules, classes }, `${name}.PcbDoc`);
  // The stack: copper names and weights, the dielectrics between them (in the layer table's order)
  const phys = new Map<number, Rec>();
  for (const r of recs) if (r[0] === 'LAYER_PHYS') phys.set(n(r[1]), r);
  const copper: StackCopper[] = copperOrder.map((id) => ({ name: s(layerRow.get(id)?.[3]) || undefined, thickness: n(phys.get(id)?.[3]) > 0 ? mil(n(phys.get(id)![3])) : undefined }));
  // The dielectrics in the stack's order (the physical rows' order, EasyEDA's own way), else the layer table's in use
  const isSub = (id: number) => s(layerRow.get(id)?.[2]).toUpperCase() === 'SUBSTRATE' || (id >= 101 && id <= 130) || id >= 361;
  const physOrder = recs.filter((r) => r[0] === 'LAYER_PHYS').map((r) => n(r[1]));
  const inStack = physOrder.filter(isSub);
  const dielIds = inStack.length === copperOrder.length - 1 ? inStack : [...layerRow.values()].filter((r) => s(r[2]).toUpperCase() === 'SUBSTRATE' && (n(r[4]) & 1)).map((r) => n(r[1]));
  const diels: StackDielectric[] = dielIds.map((id) => {
    const ph = phys.get(id);
    return { thickness: n(ph?.[3]) > 0 ? mil(n(ph![3])) : undefined, material: s(ph?.[2]) || undefined, er: n(ph?.[4]) > 0 ? n(ph![4]) : undefined };
  });
  applyStackLayers(pcbDoc, copper, diels.length === copperOrder.length - 1 ? diels : []);
  for (const [m, nm] of mechNames) pcbDoc.board.layerNames.set(mechLayer(m), nm);
  const unpoured = pourOrder.filter((q) => !q.poured);
  for (const q of unpoured) repour(pcbDoc, q.index).apply();
  if (unpoured.length && poured.length) warnings.push(`${unpoured.length} pour${unpoured.length === 1 ? '' : 's'} not poured in the file: poured with the board's rules`);
  else if (unpoured.length) warnings.push(`The file holds no poured copper: its ${unpoured.length} pour${unpoured.length === 1 ? '' : 's'} poured with the board's rules`);
  for (const [k, c] of tally) warnings.push(`Left out: ${k} (${c})`);
  const footprints = footprintsFromBoard(pcbDoc);
  return { bytes: writePcbDoc(pcbDoc), name, footprints, warnings, stats: { components: nComps, pads: pads.length, vias: nVias, tracks: nTracks, nets: nets.length, layers: copperOrder.length } };
}

/** Footprints (a library's, or lone ones) as AD's: each placed alone on a board, read back as the library's. */
export function proFootprintLibrary(p: ProProject, ids: string[] = [...p.footprints.keys()]): { footprints: FootprintDef[]; warnings: string[] } {
  const recs: Rec[] = [];
  ids.forEach((id, i) => {
    recs.push(['COMPONENT', `c${i}`, 0, 1, (i % 10) * 2000, Math.floor(i / 10) * 2000, 0, {}, 0]);
    recs.push(['ATTR', `c${i}f`, 0, `c${i}`, 3, null, null, 'Footprint', id, 0, 0]);
    recs.push(['ATTR', `c${i}d`, 0, `c${i}`, 3, null, null, 'Designator', `F${i + 1}`, 0, 0]);
  });
  const r = convertProPcb(p, { type: 'PCB', uuid: '', title: 'Footprints', recs }, 'Footprints');
  return { footprints: r.footprints, warnings: r.warnings.filter((w) => !/board outline|poured/i.test(w)) };
}
