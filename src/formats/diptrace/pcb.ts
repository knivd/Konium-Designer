/**
 * DipTrace boards as AD's: the copper layers (signal and plane layers in DipTrace's order, a plane
 * an internal plane of its net), the board outline (its arcs through three points [est]) and the
 * Board Cutout shapes as cut-outs, components placed as DipTrace places them (their patterns'
 * pads from the pad styles: round, oval, rectangle, rounded rectangle, polygon pads, D-shapes as
 * rectangles, fiducials; slotted holes; mask and paste states and swells), the marking fields
 * where DipTrace shows them (silk and assembly), free pads, static vias, the nets' traces (each
 * segment's layer and width, vias at their points by via style, blind and buried by its layers),
 * copper pours as polygon pours (solid or hatched, priority, clearance, spokes), the free shapes
 * and text on the layers they're on (keep-outs as keep-outs, the documentation layers as
 * mechanical layers named after them), net classes, the design rules, the stack-up. DipTrace's
 * units (mm, inch, mil), Y up, its origin AD's.
 */
import type { Vec2 } from '../../core/geom';
import { formatAltiumLength, mil, mm, UNITS_PER_MM } from '../../core/units';
import { L, mechLayer, type LayerId } from '../../model/layers';
import type { PolyVertex } from '../../model/pcb';
import { footprintsFromBoard } from '../../model/pcbLib';
import { repour } from '../../model/pcbEdit';
import { PAD_SHAPE_KEY } from '../../model/padShapes';
import { newBoardRecord } from '../altium/board6';
import { assemblePcbDoc, applyStackLayers, type StackCopper, type StackDielectric } from '../altium/assemble';
import { encodeArc, encodePad, encodeRegion, encodeText, encodeTrack, encodeVia, layerToName, writePcbDoc, writeVertices, type PadFields } from '../altium/pcbdoc';
import type { FootprintDef } from '../altium/pcblib';
import type { PcbRawRecord } from '../altium/framing';
import { PropertyBag } from '../altium/props';
import { altiumFloat } from '../altium/pcbTransform';
import { newPolygonProps } from '../altium/polygonProps';
import { newRule } from '../altium/rules';
import { boardRules, uniqueIdFor } from '../kicad/board';
import { arcThrough } from '../kicad/schematic';
import { strokeTextWidth } from '../gerber/stroke';
import { kid, kidsOf, type XEl } from '../xml';
import { deg, dnum, dtext, dyes, fontMm, live, patternNameMap, pointsOf, textLines, type DtDoc } from './read';

export interface DtPcbResult {
  bytes: Uint8Array; name: string; footprints: FootprintDef[]; warnings: string[];
  stats: { components: number; pads: number; vias: number; tracks: number; nets: number; layers: number; pours: number };
}

const norm = (a: number) => ((a % 360) + 360) % 360;
const BOARD_SHAPES = ['Line', 'Arc', 'Rectangle', 'FillRect', 'Obround', 'FillObround', 'Text', 'Picture', 'Polyline', 'Polygon', 'QR'];
const PATTERN_SHAPES = ['None', 'Line', 'Rectangle', 'Obround', 'FillRect', 'FillObround', 'Arc', 'Text', 'Polyline', 'Polygon'];
/** A shape's kind: its name, or its number in the board's or the pattern's list. */
const shapeKind = (e: XEl, pattern: boolean): string => { const t = e.attrs.Type ?? ''; return /^\d+$/.test(t) ? ((pattern ? PATTERN_SHAPES : BOARD_SHAPES)[Number(t)] ?? t) : t; };
/** DipTrace's documentation layers on AD's mechanical layers: their number and name. */
const MECH: Record<string, [number, string]> = {
  'Top Assy': [13, 'Top Assembly'], 'Bottom Assy': [14, 'Bottom Assembly'], 'Top Courtyard': [15, 'Top Courtyard'], 'Bottom Courtyard': [16, 'Bottom Courtyard'],
  'Top Outline': [2, 'Top Component Outline'], 'Bottom Outline': [3, 'Bottom Component Outline'], 'Top Dimension': [4, 'Top Dimension'], 'Bottom Dimension': [5, 'Bottom Dimension'],
  'Placement Keepout': [6, 'Placement Keepout'],
};
const MECH_FREE = [7, 8, 9, 10, 11, 12, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];
const SWAP: Record<string, string> = { Top: 'Bottom', Bottom: 'Top' };
/** A layer token as seen from the other side ("Top Silk" ↔ "Bottom Silk"). */
const flipToken = (t: string) => t.replace(/^(Top|Bottom)\b/, (m) => SWAP[m]!);

type Edge = PolyVertex;

/** The pads and drawing of a pattern placed: where its origin goes, its turn (degrees anticlockwise), its side. */
interface Place { x: number; y: number; angle: number; bottom: boolean; ox: number; oy: number; owner?: number }

export function convertDipTracePcb(doc: DtDoc, name: string, opts: { stem?: string; /** A library: these patterns (styles) each placed alone. */ patterns?: string[];
  /** An automatic net's name as the schematic's compile gives it, by its pins ("R1.2"). */ netName?: (pins: string[]) => string | undefined } = {}): DtPcbResult {
  const board = doc.body;
  const K = doc.k;
  const warnings: string[] = [];
  const warned = new Set<string>();
  const warnOnce = (w: string) => { if (!warned.has(w)) { warned.add(w); warnings.push(w); } };
  const tally = new Map<string, number>();
  const skip = (what: string) => tally.set(what, (tally.get(what) ?? 0) + 1);
  const stem = opts.stem ?? name;
  const len = (v: number) => Math.max(0, Math.round(v * K * UNITS_PER_MM));
  const settings = kid(board, 'Settings');

  /* ── copper layers: DipTrace's order, the first the top, the last the bottom; planes AD's internal planes ── */
  const lays = kidsOf(kid(board, 'CopperLayers'), 'Lay');
  const layList = lays.length >= 2 ? lays : [{ name: 'Lay', attrs: { Id: '0', Type: 'Signal' }, children: [], text: '' }, { name: 'Lay', attrs: { Id: '1', Type: 'Signal' }, children: [], text: '' }] as XEl[];
  const copperIdOf = new Map<number, LayerId>();
  let mid = 0, plane = 0;
  layList.forEach((l, i) => {
    const id = dnum(l, 'Id', i);
    const isPlane = l.attrs.Type === 'Plane';
    copperIdOf.set(id, (i === 0 ? L.TOP : i === layList.length - 1 ? L.BOTTOM : isPlane && i > 0 ? L.PLANE1 + plane++ : L.MID1 + mid++) as LayerId);
  });
  const topId = dnum(layList[0], 'Id', 0), botId = dnum(layList.at(-1), 'Id', 1);
  const copperOf = (id: number): LayerId | undefined => copperIdOf.get(id);
  const signalLayers = [...copperIdOf.values()].filter((l) => l < L.PLANE1 || l > L.PLANE1 + 15);

  /* ── mechanical layers by name ── */
  const mechNames = new Map<number, string>([[1, 'Board Outline']]);
  const mechByName = new Map<string, number>();
  let mechNext = 0;
  const nonSignal = new Map(kidsOf(kid(board, 'NonSignals'), 'NonSignal').map((n) => [dnum(n, 'Id'), dtext(n, 'Name') || `Non-Signal ${n.attrs.Id ?? ''}`]));
  const mechFor = (nm: string, fixed?: number): LayerId => {
    let m = fixed ?? mechByName.get(nm);
    if (m === undefined) { m = mechNext < MECH_FREE.length ? MECH_FREE[mechNext++]! : 32; mechByName.set(nm, m); }
    if (!mechNames.has(m)) mechNames.set(m, m === 32 && mechByName.size > MECH_FREE.length ? 'Other DipTrace Layers' : nm);
    return mechLayer(m) as LayerId;
  };
  type Target = { layers: LayerId[]; keepout?: boolean; cutout?: boolean } | null;
  /** A layer token (and its copper or non-signal layer id) as AD's layers. */
  const targetOf = (token: string, layId: number, allLayers: boolean): Target => {
    switch (token) {
      case 'Top Silk': return { layers: [L.TOP_OVERLAY] };
      case 'Bottom Silk': return { layers: [L.BOTTOM_OVERLAY] };
      case 'Top Mask': return { layers: [L.TOP_SOLDER] };
      case 'Bottom Mask': return { layers: [L.BOTTOM_SOLDER] };
      case 'Top Paste': return { layers: [L.TOP_PASTE] };
      case 'Bottom Paste': return { layers: [L.BOTTOM_PASTE] };
      case 'Top': return { layers: [L.TOP] };
      case 'Bottom': return { layers: [L.BOTTOM] };
      case 'Top Keepout': return { layers: [L.TOP], keepout: true };
      case 'Bottom Keepout': return { layers: [L.BOTTOM], keepout: true };
      case 'Route Keepout': return { layers: [L.KEEPOUT], keepout: true };
      case 'Board Cutout': return { layers: [L.MULTI], cutout: true };
      case 'Signal/Plane': { if (allLayers) return { layers: signalLayers }; const c = copperOf(layId); return c === undefined ? null : { layers: [c] }; }
      case 'Non-Signal': return { layers: [mechFor(nonSignal.get(layId) ?? `Non-Signal ${layId}`)] };
      case 'Top Terminals': case 'Bottom Terminals': case 'None': case '': return null;
      default: { const m = MECH[token]; return m ? { layers: [mechFor(m[1], m[0])] } : { layers: [mechFor(token)] }; }
    }
  };

  /* ── coordinates: DipTrace's origin AD's, 1000 mil in from the sheet's corner past what lies left of or below it ── */
  let x0 = 0, y0 = 0;
  const seePt = (x: number, y: number) => { if (x < x0) x0 = x; if (y < y0) y0 = y; };
  const outlinePts = pointsOf(doc, kid(board, 'BoardOutline'));
  for (const p of outlinePts) seePt(p.x, p.y);
  for (const c of kidsOf(kid(board, 'Components'), 'Component')) seePt(dnum(c, 'X') * K - 10, dnum(c, 'Y') * K - 10);
  const P = (v: Vec2): Vec2 => ({ x: Math.round(mil(1000) + (v.x - x0) * UNITS_PER_MM), y: Math.round(mil(1000) + (v.y - y0) * UNITS_PER_MM) });
  /** A pattern point (file units) placed (mm). */
  const placeMm = (pl: Place, q: Vec2): Vec2 => {
    const lx = (q.x - pl.ox) * K * (pl.bottom ? -1 : 1), ly = (q.y - pl.oy) * K;
    const a = (pl.angle * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    return { x: pl.x + lx * c - ly * s, y: pl.y + lx * s + ly * c };
  };
  const placed = (pl: Place, q: Vec2): Vec2 => P(placeMm(pl, q));
  /** A pattern-relative turn (degrees) placed. */
  const turn = (pl: Place, a: number) => norm(pl.angle + (pl.bottom ? -a : a));

  /* ── nets ── */
  const netEls = kidsOf(kid(board, 'Nets'), 'Net').filter(live);
  const nets: string[] = [];
  const netIndex = new Map<number, number>();
  const taken = new Set<string>();
  // Each net's pins (reference and pad number), for the schematic's names of DipTrace's automatic ones
  const pinsOfNet = new Map<number, string[]>();
  if (opts.netName) for (const c of kidsOf(kid(board, 'Components'), 'Component')) {
    const pat = doc.patterns.get(c.attrs.PatternStyle ?? '');
    if (!pat || c.attrs.Type) continue;
    const numberOf = new Map(kidsOf(kid(pat, 'Pads'), 'Pad').map((p) => [p.attrs.Id ?? '', dtext(p, 'Number') || p.attrs.Id || '']));
    for (const p of kidsOf(kid(c, 'Pads'), 'Pad')) { const id = dnum(p, 'NetId', -1); if (id >= 0) pinsOfNet.set(id, [...(pinsOfNet.get(id) ?? []), `${dtext(c, 'RefDes')}.${numberOf.get(p.attrs.Id ?? '') ?? p.attrs.Id}`]); }
  }
  netEls.forEach((n, i) => {
    let nm = dtext(n, 'Name') || `N${dnum(n, 'Id', i)}`;
    if (opts.netName && /^Net ?\d+$/i.test(nm)) { const k = opts.netName(pinsOfNet.get(dnum(n, 'Id', i)) ?? []); if (k && !taken.has(k.toUpperCase())) nm = k; }
    for (let k = 2; taken.has(nm.toUpperCase()); k++) nm = `${dtext(n, 'Name') || 'N'}_${k}`;
    taken.add(nm.toUpperCase());
    netIndex.set(dnum(n, 'Id', i), nets.length);
    nets.push(nm);
  });
  const netOf = (id: number | undefined) => (id === undefined || id < 0 ? undefined : netIndex.get(id));

  const compBags: PropertyBag[] = [];
  const pads: PcbRawRecord[] = [], tracks: PcbRawRecord[] = [], arcs: PcbRawRecord[] = [], vias: PcbRawRecord[] = [], regions: PcbRawRecord[] = [], texts: PcbRawRecord[] = [];
  const polygons: PropertyBag[] = [];
  const pourRank: { index: number; rank: number }[] = [];
  const pourClear = new Map<number, string[]>();
  const directPolys: string[] = [];
  const cutouts: Vec2[][] = [];
  let nTracks = 0, nVias = 0, nPads = 0;

  const keepout = (rec: PcbRawRecord) => { rec.subs[0]![2] = 2; return rec; };
  const lw = (e: XEl, d: number) => { const w = dnum(e, 'LineWidth', -1); return w >= 0 ? len(w) : Math.round(d * UNITS_PER_MM); };
  const defaultWidth = (token: string) => {
    const t = token.toLowerCase();
    const w = kid(settings, 'LineWidth');
    const val = (k: string, d: number) => { const v = Number(dtext(w, k).replace(',', '.')); return Number.isFinite(v) && v > 0 && dtext(w, k) ? v * K : d; };
    return t.includes('silk') ? val('Silk', 0.15) : t.includes('assy') ? val('Assembly', 0.1) : t.includes('courtyard') ? val('Courtyard', 0.05) : t.includes('outline') ? val('CompOutline', 0.05) : 0.1;
  };

  /* ── drawing: a shape (board's or a pattern's) on its layers ── */
  const arcRec = (layer: LayerId, a: Vec2, m: Vec2, b: Vec2, width: number, net?: number, owner?: number) => {
    const t = arcThrough(a, m, b);
    if (!t) return encodeTrack({ layer, a, b, width, net, component: owner });
    return encodeArc({ layer, c: { x: Math.round(t.c.x), y: Math.round(t.c.y) }, r: Math.round(t.r), start: t.start, end: t.end, width, net, component: owner });
  };
  /** A closed ring's vertices (AD units) with its arcs (a point flagged Arc the start of an arc through the next to the one after [est]). */
  const ringVerts = (pts: (Vec2 & { arc?: boolean })[], map: (q: Vec2) => Vec2): PolyVertex[] => {
    const out: PolyVertex[] = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const p = pts[i]!;
      const a = map(p);
      if (p.arc && n >= 3) {
        const m = map(pts[(i + 1) % n]!), b = map(pts[(i + 2) % n]!);
        const t = arcThrough(a, m, b);
        if (t) { out.push({ p: a, arc: { c: t.c, r: t.r, sa: t.start, ea: t.end } }); i++; warnOnce('Arcs read as passing through the point after their start [est]'); continue; }
      }
      out.push({ p: a });
    }
    return out;
  };
  const flat = (vs: PolyVertex[]): Vec2[] => {
    const out: Vec2[] = [];
    for (const v of vs) {
      out.push(v.p);
      if (v.arc) {
        const { c, r, sa, ea } = v.arc;
        const at = (d: number) => ({ x: c.x + r * Math.cos((d * Math.PI) / 180), y: c.y + r * Math.sin((d * Math.PI) / 180) });
        const fwd = Math.hypot(at(sa).x - v.p.x, at(sa).y - v.p.y) <= Math.hypot(at(ea).x - v.p.x, at(ea).y - v.p.y);
        const span = norm(ea - sa) || 360, k = Math.max(2, Math.ceil(span / 6));
        for (let j = 1; j < k; j++) out.push(at(fwd ? sa + (span * j) / k : ea - (span * j) / k));
      }
    }
    return out.map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) }));
  };
  /** An obround's outline in a box. */
  const obround = (a: Vec2, b: Vec2): Vec2[] => {
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y), r = Math.min(w, h) / 2;
    const out: Vec2[] = [];
    const along = w >= h;
    const half = (along ? w : h) / 2 - r;
    for (const side of [1, -1]) for (let k = 0; k <= 12; k++) {
      const t = (along ? -Math.PI / 2 : 0) + (side === 1 ? 0 : Math.PI) + (Math.PI * k) / 12;
      out.push(along ? { x: cx + side * half + r * Math.cos(t), y: cy + r * Math.sin(t) } : { x: cx + r * Math.cos(t), y: cy + side * half + r * Math.sin(t) });
    }
    return out;
  };

  /** A shape on its layers through `map` (file units → AD), a pattern's when owned. */
  const shapeOf = (e: XEl, map: (q: Vec2) => Vec2, pattern: boolean, flip: boolean, owner: number | undefined, resolve?: (show: string) => string | undefined, pl?: Place) => {
    if (!live(e)) return;
    const kind = shapeKind(e, pattern);
    let token = e.attrs.Layer ?? '';
    if (flip) token = flipToken(token);
    const tgt = targetOf(token, dnum(e, 'LayId', -1), dyes(e, 'AllLayers'));
    if (!tgt) { if (token && !/Terminals/.test(token)) skip(`shapes on ${token}`); return; }
    const pts = kidsOf(kid(e, 'Points'), 'Point').map((p) => ({ x: dnum(p, 'X'), y: dnum(p, 'Y'), arc: dyes(p, 'Arc') }));
    const net = netOf(e.attrs.NetId !== undefined ? dnum(e, 'NetId', -1) : undefined);
    const width = Math.max(1, lw(e, defaultWidth(token)));
    const copper = (l: LayerId) => l <= L.BOTTOM;
    const push = (rec: PcbRawRecord, arc = false) => { (arc ? arcs : tracks).push(tgt.keepout ? keepout(rec) : rec); nTracks++; };
    const fill = (ring: Vec2[]) => {
      if (ring.length < 3) return;
      if (tgt.cutout) { cutouts.push(ring); return; }
      for (const l of tgt.layers) { const r = encodeRegion({ layer: l, outline: ring, net: copper(l) ? net : undefined, component: owner }); regions.push(tgt.keepout ? keepout(r) : r); }
    };
    const stroke = (ring: Vec2[], closed: boolean) => {
      if (tgt.cutout) { if (closed) cutouts.push(ring); return; }
      for (const l of tgt.layers) for (let i = 0; i + 1 < ring.length + (closed ? 1 : 0); i++) push(encodeTrack({ layer: l, a: ring[i]!, b: ring[(i + 1) % ring.length]!, width, net: copper(l) ? net : undefined, component: owner }));
    };
    switch (kind) {
      case 'Line': case 'Polyline': {
        if (pts.length < 2) return;
        if (tgt.cutout) { if (pts.length >= 3) cutouts.push(flat(ringVerts(pts, map))); return; }
        for (const l of tgt.layers) {
          for (let i = 1; i < pts.length; i++) {
            const p = pts[i]!;
            if (p.arc && i + 1 < pts.length) { push(arcRec(l, map(pts[i - 1]!), map(p), map(pts[i + 1]!), width, copper(l) ? net : undefined, owner), true); i++; warnOnce('Arcs read as passing through the point after their start [est]'); continue; }
            push(encodeTrack({ layer: l, a: map(pts[i - 1]!), b: map(p), width, net: copper(l) ? net : undefined, component: owner }));
          }
        }
        return;
      }
      case 'Arc': {
        if (pts.length < 3) return;
        if (tgt.cutout) return;
        for (const l of tgt.layers) push(arcRec(l, map(pts[0]!), map(pts[1]!), map(pts[2]!), width, copper(l) ? net : undefined, owner), true);
        return;
      }
      case 'Rectangle': case 'FillRect': {
        if (pts.length < 2) return;
        const a = pts[0]!, b = pts[1]!;
        const ring = [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }].map(map);
        if (kind === 'FillRect') fill(ring); else stroke(ring, true);
        return;
      }
      case 'Obround': case 'FillObround': {
        if (pts.length < 2) return;
        const ring = obround(pts[0]!, pts[1]!).map(map);
        if (kind === 'FillObround') fill(ring); else stroke(ring, true);
        return;
      }
      case 'Polygon': { if (pts.length >= 3) fill(flat(ringVerts(pts, map))); return; }
      case 'Text': {
        const show = e.attrs.TextShow ?? 'Any Text';
        const lines = show === 'Any Text' || !resolve ? textLines(e) : [resolve(show) ?? ''];
        if (!pts.length || !lines.some((t) => t.trim())) return;
        const size = dnum(e, 'FontSizeFloat', dnum(e, 'FontSize', 10));
        const ang = pattern && pl ? turn(pl, deg(dnum(e, 'Angle'))) : norm(deg(dnum(e, 'Angle')));
        for (const l of tgt.layers) textAt(lines, l, map(pts[0]!), ang, e.attrs.HorzAlign ?? 'Center', e.attrs.VertAlign ?? 'Center', size, dnum(e, 'LineSpacing', 1.2), owner);
        return;
      }
      case 'Picture': case 'QR': case '10': skip(kind === 'Picture' ? 'pictures' : 'QR codes'); return;
      default: skip(`shapes of kind ${kind || '?'}`);
    }
  };

  /** Text lines at an anchor by DipTrace's alignment, AD's stroke text (mirrored on the bottom side). */
  const textAt = (lines: string[], layer: LayerId, at0: Vec2, angle: number, horz: string, vert: string, sizePt: number, spacing: number, owner?: number, role?: 'designator' | 'comment') => {
    const h = Math.max(mil(4), Math.round(fontMm(sizePt) * UNITS_PER_MM));
    const stroke = Math.max(mil(1), Math.round(h * 0.13));
    const mirrored = layer === L.BOTTOM_OVERLAY || layer === L.BOTTOM || layer === L.BOTTOM_SOLDER || layer === L.BOTTOM_PASTE;
    const hh = horz === 'Left' ? 0 : horz === 'Right' ? 2 : 1, vv = vert === 'Bottom' ? 0 : vert === 'Top' ? 2 : 1;
    const pitch = Math.round(h * spacing);
    const block = h + (lines.length - 1) * pitch;
    const th = (angle * Math.PI) / 180, ux = Math.cos(th), uy = Math.sin(th), dir = mirrored ? -1 : 1;
    lines.forEach((line, i) => {
      if (!line.trim() && !(role && i === 0)) return;
      const w = strokeTextWidth(line, h);
      const up = (lines.length - 1 - i) * pitch - (vv / 2) * block;
      const along = (hh / 2) * w * dir;
      const at = { x: Math.round(at0.x - along * ux - up * uy), y: Math.round(at0.y - along * uy + up * ux) };
      texts.push(encodeText({ layer, at, height: h, text: line, rotation: angle, strokeWidth: stroke, mirrored, component: owner, isDesignator: role === 'designator' && i === 0, isComment: role === 'comment' && i === 0 }));
    });
  };

  /* ── pads ── */
  const padOf = (p: XEl, pl: Place, net: number | undefined, owner: number | undefined, nameOverride?: string) => {
    const style = doc.padStyles.get(p.attrs.Style ?? '');
    if (!style) { skip('pads whose pad style is missing'); return; }
    const main = kid(style, 'MainStack');
    const shapeName = main?.attrs.Shape ?? 'Ellipse';
    const fid = shapeName === 'Fiducial' || shapeName === '20';
    const w = len(dnum(main, 'Width')), h = fid ? w : len(dnum(main, 'Height', dnum(main, 'Width')));
    if (w <= 0 || h <= 0) { skip('pads of no size'); return; }
    const through = style.attrs.Type === 'Through';
    const name = nameOverride ?? (kid(p, 'Number') ? dtext(p, 'Number') : p.attrs.Id ?? '');
    const local = { x: dnum(p, 'X'), y: dnum(p, 'Y') };
    const at = placed(pl, local);
    const rotation = turn(pl, deg(dnum(p, 'Angle')));
    if (through && (dnum(main, 'XOff') || dnum(main, 'YOff'))) warnOnce('Pads whose copper is offset from the hole: the copper centred on the hole');
    let shape: PadFields['shape'] = 'round', cornerPct: number | undefined;
    switch (shapeName) {
      case 'Ellipse': case '0': if (w !== h) warnOnce('Elliptical pads made oval'); break;
      case 'Obround': case '1': break;
      case 'Rectangle': case '2': { const c = dnum(main, 'Corner'); if (c > 0) { shape = 'roundrect'; cornerPct = Math.min(100, Math.round(c * 2)); } else shape = 'rect'; break; }
      case 'D-shape': case '4': shape = 'roundrect'; cornerPct = 50; warnOnce('D-shaped pads made rounded rectangles'); break;
      case 'Polygon': case '3': shape = 'rect'; break;
      default:
    }
    // Mask and paste
    const mp = kid(style, 'MaskPaste') ?? kid(p, 'MaskPaste');
    const side = pl.bottom ? 'Bot' : 'Top';
    const maskMode = mp?.attrs[`${side}Mask`], pasteMode = mp?.attrs[`${side}Paste`];
    let solderExpansion: number | undefined = mp?.attrs.CustomSwell !== undefined && dnum(mp, 'CustomSwell', -1000) > -1000 ? len(dnum(mp, 'CustomSwell')) : undefined;
    let pasteExpansion: number | undefined = mp?.attrs.CustomShrink !== undefined && dnum(mp, 'CustomShrink', -1000) > -1000 ? -len(dnum(mp, 'CustomShrink')) : undefined;
    if (maskMode === 'Tented') solderExpansion = -Math.max(w, h);
    if (pasteMode === 'No Solder') pasteExpansion = -Math.max(w, h);
    if (fid) { solderExpansion = Math.max(0, Math.round((len(dnum(style, 'Hole')) - w) / 2)); pasteExpansion = -w; }
    let hole: number | undefined, slot: PadFields['slot'];
    if (through && !fid) {
      const hw = len(dnum(style, 'Hole')), hh2 = style.attrs.HoleType === 'Obround' ? len(dnum(style, 'HoleH', dnum(style, 'Hole'))) : hw;
      hole = Math.min(hw, hh2) || hw;
      if (Math.abs(hw - hh2) > 1) slot = { length: Math.max(hw, hh2), rotation: hh2 > hw ? 90 : 0 };
    }
    const padSide = (p.attrs.Side ?? 'Top') === 'Bottom' !== pl.bottom;
    const layer = through && !fid ? L.MULTI : padSide ? (copperOf(botId) ?? L.BOTTOM) : (copperOf(topId) ?? L.TOP);
    const poly = shapeName === 'Polygon' || shapeName === '3' ? pointsOf(doc, main) : [];
    if (poly.length >= 3) {
      // A polygon pad: its anchor, and its copper (and openings) as its shape's regions
      const ring = poly.map((q) => placed(pl, { x: local.x + rotate(q, dnum(p, 'Angle')).x / K, y: local.y + rotate(q, dnum(p, 'Angle')).y / K }));
      const xs = ring.map((q) => q.x), ys = ring.map((q) => q.y);
      const anchor = Math.max(mil(2), Math.round(Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 3));
      pads.push(encodePad({ name, layer, at, w: Math.max(anchor, (hole ?? 0) + 1), h: Math.max(anchor, (hole ?? 0) + 1), shape: 'round', rotation, hole, slot, plated: through, net, component: owner, solderExpansion, pasteExpansion }));
      const coppers = layer === L.MULTI ? [L.TOP, L.BOTTOM] : [layer];
      for (const cl of coppers) regions.push(encodeRegion({ layer: cl, outline: ring, net, component: owner, extra: { [PAD_SHAPE_KEY]: name } }));
      const outer = layer === L.MULTI ? [L.TOP_SOLDER, L.BOTTOM_SOLDER] : layer === L.TOP ? [L.TOP_SOLDER, ...(pasteMode === 'No Solder' ? [] : [L.TOP_PASTE])] : [L.BOTTOM_SOLDER, ...(pasteMode === 'No Solder' ? [] : [L.BOTTOM_PASTE])];
      if (maskMode !== 'Tented') for (const ol of outer) regions.push(encodeRegion({ layer: ol as LayerId, outline: ring, component: owner, extra: { [PAD_SHAPE_KEY]: name } }));
      nPads++;
      return;
    }
    pads.push(encodePad({ name, layer, at, w: Math.max(w, (hole ?? 0) + 1), h: Math.max(h, (hole ?? 0) + 1), shape, cornerPct, rotation, hole, slot, plated: through, net, component: owner, solderExpansion, pasteExpansion }));
    nPads++;
  };
  const rotate = (q: { x: number; y: number }, rad: number) => ({ x: q.x * Math.cos(rad) - q.y * Math.sin(rad), y: q.x * Math.sin(rad) + q.y * Math.cos(rad) });

  /** A pattern placed: its pads (nets by their ids), holes and drawing. */
  const patternInto = (pat: XEl, pl: Place, owner: number | undefined, padNet: (id: string) => number | undefined, resolve?: (show: string) => string | undefined) => {
    for (const p of kidsOf(kid(pat, 'Pads'), 'Pad')) if (live(p)) padOf(p, pl, padNet(p.attrs.Id ?? ''), owner);
    for (const hl of kidsOf(kid(pat, 'Holes'), 'Hole')) {
      if (!live(hl)) continue;
      const d = len(dnum(hl, 'HoleDiam'));
      if (d > 0) pads.push(encodePad({ name: '', layer: L.MULTI, at: placed(pl, { x: dnum(hl, 'X'), y: dnum(hl, 'Y') }), w: d, h: d, shape: 'round', hole: d, plated: false, component: owner }));
    }
    for (const s of kidsOf(kid(pat, 'Shapes'), 'Shape')) shapeOf(s, (q) => placed(pl, q), true, pl.bottom, owner, resolve, pl);
    if (kidsOf(kid(pat, 'Dimensions'), 'Dimension').length) skip('pattern dimensions');
  };
  const originOf = (pat: XEl) => { const o = kid(pat, 'Origin'); const ox = dnum(o, 'X'), oy = dnum(o, 'Y'); if (ox || oy) warnOnce('Patterns whose origin is off their centre placed by their origin [est]'); return { ox, oy }; };

  /* ── footprint names: the patterns' names, made unique ── */
  const fpNames = patternNameMap(doc);
  const nameOfPattern = (style: string): string => fpNames.get(style) ?? style;

  /* ── the components ── */
  const marks = kid(settings, 'Markings');
  const globalShow = (field: string, layer: 'Silk' | 'Assy') => kid(marks, `${field}Global`)?.attrs[`${layer}Show`] ?? (field === 'RefDes' && layer === 'Silk' ? 'Show' : 'Hide');
  const globalSize = dnum({ name: '', attrs: { v: dtext(marks, 'FontSizeFloat') || dtext(marks, 'FontSize') }, children: [], text: '' }, 'v', 6);
  const viaStyles = kidsOf(kid(board, 'ViaStyles'), 'ViaStyle');
  const viaOf = (at: Vec2, styleIndex: number, net: number | undefined) => {
    const vs = viaStyles[styleIndex] ?? viaStyles[0];
    const size = vs ? len(dnum(vs, 'Size')) : mil(24), hole = vs ? len(dnum(vs, 'HoleSize')) : mil(12);
    const l1 = vs?.attrs.Lay1 !== undefined ? copperOf(dnum(vs, 'Lay1')) : undefined, l2 = vs?.attrs.Lay2 !== undefined ? copperOf(dnum(vs, 'Lay2')) : undefined;
    const blind = l1 !== undefined && l2 !== undefined && !(Math.min(l1, l2) === L.TOP && Math.max(l1, l2) === L.BOTTOM);
    const order = (l: LayerId) => (l === L.TOP ? 0 : l === L.BOTTOM ? 99 : l);
    const [a, b] = blind ? [l1!, l2!].sort((x, y) => order(x) - order(y)) : [L.TOP, L.BOTTOM];
    vias.push(encodeVia({ at, diameter: Math.max(size, hole + 1), hole, net, ...(blind ? { layerStart: a as LayerId, layerEnd: b as LayerId } : {}) }));
    nVias++;
  };

  let nComps = 0;
  const comps = opts.patterns
    ? opts.patterns.map((st, i): XEl => ({ name: 'Component', attrs: { PatternStyle: st, X: String(((i % 10) * 20) / K), Y: String((Math.floor(i / 10) * 20) / K) }, children: [{ name: 'RefDes', attrs: {}, children: [], text: `F${i + 1}` }], text: '' }))
    : kidsOf(kid(board, 'Components'), 'Component').filter(live);
  for (const c of comps) {
    const type = c.attrs.Type ?? '';
    const x = dnum(c, 'X') * K, y = dnum(c, 'Y') * K;
    const padsEl = kidsOf(kid(c, 'Pads'), 'Pad');
    const padNetMap = new Map(padsEl.map((p) => [p.attrs.Id ?? '', netOf(dnum(p, 'NetId', -1))]));
    if (type === 'Via') { viaOf(P({ x, y }), dnum(c, 'ViaStyle', 0), padNetMap.values().next().value); continue; }
    const pat = doc.patterns.get(c.attrs.PatternStyle ?? '');
    if (!pat) { skip(type ? `${type.toLowerCase()} objects whose pattern is missing` : 'components whose pattern is missing'); continue; }
    const bottom = c.attrs.Side === 'Bottom';
    if (dyes(c, 'Flip') || dyes(c, 'HorzFlip')) warnOnce('Components mirrored on their own side placed unmirrored');
    const angle = norm(deg(dnum(c, 'Angle')));
    const { ox, oy } = originOf(pat);
    // A free pad, mounting hole or fiducial: its pattern's objects, no component
    if (type === 'Pad' || type === 'MtHole' || type === 'Fiducial') {
      const pl: Place = { x, y, angle, bottom, ox, oy };
      patternInto(pat, pl, undefined, (id) => padNetMap.get(id) ?? padNetMap.values().next().value);
      continue;
    }
    const refdes = dtext(c, 'RefDes') || `U${nComps + 1}`;
    const value = dtext(c, 'Value'), cname = dtext(c, 'Name');
    const comment = value || cname;
    const ci = compBags.length;
    const pl: Place = { x, y, angle, bottom, ox, oy, owner: ci };
    const pos = P({ x, y });
    const fields: Record<string, string> = { RefDes: refdes, Value: value, Name: cname, Pattern: dtext(pat, 'Name'), Manufacturer: dtext(c, 'Manufacturer'), Datasheet: dtext(c, 'Datasheet'), 'Unique Name': dtext(pat, 'Name_Unique') };
    const shownField = (field: string, layer: 'Silk' | 'Assy'): XEl | undefined => {
      const m = kid(kid(c, `${field}Marking`), layer);
      const show = m?.attrs.Show ?? 'Common';
      const s = show === 'Common' ? globalShow(field, layer) : show;
      return s === 'Show' ? m ?? { name: layer, attrs: { Align: 'Auto' }, children: [], text: '' } : undefined;
    };
    const refOn = shownField('RefDes', 'Silk'), valOn = shownField('Value', 'Silk');
    compBags.push(PropertyBag.from({
      LAYER: bottom ? 'BOTTOM' : 'TOP', PATTERN: nameOfPattern(c.attrs.PatternStyle ?? ''), SOURCEDESIGNATOR: refdes, SOURCEFOOTPRINTLIBRARY: `${stem}.PcbLib`,
      X: formatAltiumLength(pos.x), Y: formatAltiumLength(pos.y), ROTATION: altiumFloat(norm(bottom ? angle + 180 : angle)),
      NAMEON: refOn ? 'TRUE' : 'FALSE', COMMENTON: valOn ? 'TRUE' : 'FALSE', LOCKED: dyes(c, 'Locked') ? 'TRUE' : 'FALSE',
      COMPONENTKIND: 0, SOURCELIBREFERENCE: cname, SOURCEUNIQUEID: opts.patterns ? '' : `\\${uniqueIdFor(`diptrace:${stem}:${refdes}`)}`, FOOTPRINTDESCRIPTION: dtext(pat, 'Name_Description'),
    }));
    patternInto(pat, pl, ci, (id) => padNetMap.get(id), (show) => (show === 'RefDes' ? refdes : show === 'Value' ? value : show === 'Name' ? cname : fields[show]));
    // The marking fields where DipTrace shows them (silk; assembly on its mechanical layer)
    const size = dyes(c, 'CustomMarkingFont') ? dnum(c, 'MarkingFontSizeFloat', dnum(c, 'MarkingFontSize', globalSize)) : globalSize;
    const pw = dnum(pat, 'Width') * K, ph = dnum(pat, 'Height') * K;
    const markAt = (m: XEl): { at: Vec2; horz: string; vert: string } => {
      const align = m.attrs.Align ?? 'Auto';
      if (align === 'Position' || align === 'Common') return { at: P({ x: x + dnum(m, 'X') * K, y: y + dnum(m, 'Y') * K }), horz: m.attrs.Horz ?? 'Center', vert: m.attrs.Vert ?? 'Center' };
      // DipTrace's own placings round the pattern's extent [est]
      const off = fontMm(size);
      const d: Record<string, Vec2> = { Center: { x: 0, y: 0 }, Top: { x: 0, y: ph / 2 + off }, Bottom: { x: 0, y: -ph / 2 - off }, Left: { x: -pw / 2 - off, y: 0 }, Right: { x: pw / 2 + off, y: 0 }, Corner: { x: -pw / 2, y: ph / 2 + off }, Auto: { x: 0, y: ph / 2 + off } };
      const q = d[align] ?? d.Auto!;
      return { at: P({ x: x + q.x, y: y + q.y }), horz: 'Center', vert: 'Center' };
    };
    const silk = bottom ? L.BOTTOM_OVERLAY : L.TOP_OVERLAY;
    const assy = mechFor(bottom ? 'Bottom Assembly' : 'Top Assembly', bottom ? 14 : 13);
    const field = (fieldName: string, text: string, role?: 'designator' | 'comment') => {
      const s = shownField(fieldName, 'Silk');
      if (s && text) { const m = markAt(s); textAt([text], silk, m.at, norm(deg(dnum(s, 'Angle'))), m.horz, m.vert, size, 1.2, ci, role); }
      else if (role) textAt([text || ' '], silk, pos, 0, 'Center', 'Center', size, 1.2, ci, role);
      const a = shownField(fieldName, 'Assy');
      if (a && text) { const m = markAt(a); textAt([text], assy, m.at, norm(deg(dnum(a, 'Angle'))), m.horz, m.vert, size, 1.2, ci); }
    };
    field('RefDes', refdes, 'designator');
    field('Value', comment, 'comment');
    field('Name', cname);
    field('Pattern', fields.Pattern ?? '');
    field('Manufacturer', fields.Manufacturer ?? '');
    field('Datasheet', fields.Datasheet ?? '');
    if (angle % 90) warnOnce('Components turned other than by quarter turns placed as turned');
    nComps++;
  }

  /* ── the nets' traces and vias ── */
  for (const n of netEls) {
    const ni = netOf(dnum(n, 'Id', -1));
    for (const t of kidsOf(kid(n, 'Traces'), 'Trace')) {
      if (!live(t)) continue;
      const pts = kidsOf(kid(t, 'Points'), 'Point');
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i]!;
        const at = P({ x: dnum(p, 'X') * K, y: dnum(p, 'Y') * K });
        if (i > 0) {
          const layer = copperOf(dnum(p, 'Lay', 0));
          if (layer === undefined) { skip('trace segments on unknown layers'); continue; }
          const width = Math.max(1, len(dnum(p, 'Width')));
          const prev = P({ x: dnum(pts[i - 1]!, 'X') * K, y: dnum(pts[i - 1]!, 'Y') * K });
          if (dyes(p, 'Arc') && i + 1 < pts.length) {
            const nx = pts[i + 1]!;
            arcs.push(arcRec(layer, prev, at, P({ x: dnum(nx, 'X') * K, y: dnum(nx, 'Y') * K }), width, ni));
            warnOnce('Arcs read as passing through the point after their start [est]');
            nTracks++;
            if (dnum(p, 'ViaStyle', -1) >= 0) viaOf(at, dnum(p, 'ViaStyle'), ni);
            i++;
            const q = pts[i]!;
            if (dnum(q, 'ViaStyle', -1) >= 0) viaOf(P({ x: dnum(q, 'X') * K, y: dnum(q, 'Y') * K }), dnum(q, 'ViaStyle'), ni);
            continue;
          }
          if (prev.x !== at.x || prev.y !== at.y) { tracks.push(encodeTrack({ layer, a: prev, b: at, width, net: ni })); nTracks++; }
          if (dnum(p, 'Jumper')) warnOnce('Jumper segments made tracks');
        }
        if (i > 0 && dnum(p, 'ViaStyle', -1) >= 0) viaOf(at, dnum(p, 'ViaStyle'), ni);
      }
    }
  }

  /* ── copper pours ── */
  const HATCH: Record<string, string> = { Solid: 'Solid', 'Horizontal Lines': 'Horizontal', 'Vertical Lines': 'Vertical', 'Cross 45': '45Degree', 'Cross 90': '90Degree' };
  for (const cp of kidsOf(kid(board, 'CopperPours'), 'CopperPour')) {
    if (!live(cp)) continue;
    const layer = copperOf(dnum(cp, 'Lay', 0));
    const ring = flat(ringVerts(pointsOf(doc, cp), P));
    if (layer === undefined || ring.length < 3) { skip('copper pours on unknown layers'); continue; }
    const net = netOf(dnum(cp, 'NetId', -1));
    const index = polygons.length;
    const pname = `${net !== undefined ? nets[net] : 'No Net'}_${index + 1}`;
    const bag = newPolygonProps(layerToName(layer), net ?? 0xffff, pname, index);
    writeVertices(bag, ring.map((q): PolyVertex => ({ p: q })));
    const width = Math.max(mil(1), len(dnum(cp, 'LineWidth', 0.254 / K)));
    bag.set('TRACKWIDTH', formatAltiumLength(width));
    const hatch = HATCH[cp.attrs.Type ?? 'Solid'] ?? 'Solid';
    bag.set('HATCHSTYLE', hatch);
    if (hatch !== 'Solid') bag.set('GRIDSIZE', formatAltiumLength(width + Math.max(mil(1), len(dnum(cp, 'LineSpacing')))));
    bag.set('REMOVEDEAD', dyes(cp, 'IslandRegion', true) ? 'TRUE' : 'FALSE');
    polygons.push(bag);
    pourRank.push({ index, rank: dnum(cp, 'Priority') });
    if (!dyes(cp, 'UseNetClearance')) { const v = Math.round(dnum(cp, 'Clearance') * K * 10000) / 10000; if (v > 0) pourClear.set(v, [...(pourClear.get(v) ?? []), pname]); }
    if ((cp.attrs.Spoke ?? '') === 'Direct') directPolys.push(pname);
    if (net === undefined) warnOnce('Copper pours of no net poured as pours of no net');
  }

  /* ── free shapes and text ── */
  for (const s of kidsOf(kid(board, 'Shapes'), 'Shape')) shapeOf(s, (q) => P({ x: q.x * K, y: q.y * K }), false, false, undefined);
  if (kidsOf(kid(board, 'Dimensions'), 'Dimension').length) skip('dimensions');
  if (kidsOf(kid(board, 'Tables'), 'Table').length) skip('tables');

  /* ── the board shape ── */
  let outline: PolyVertex[];
  if (outlinePts.length >= 3) outline = ringVerts(outlinePts.map((q) => ({ x: q.x, y: q.y, arc: q.arc })), P);
  else {
    if (!opts.patterns && (nComps || nTracks)) warnings.push('No board outline: the board shape is drawn round the contents');
    const pts = compBags.map((b) => ({ x: Number.parseFloat(b.get('X') ?? '0') * 10000, y: Number.parseFloat(b.get('Y') ?? '0') * 10000 }));
    const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
    const lo = { x: Math.min(mil(1000), ...xs) - mil(200), y: Math.min(mil(1000), ...ys) - mil(200) }, hi = { x: Math.max(mil(1400), ...xs) + mil(200), y: Math.max(mil(1300), ...ys) + mil(200) };
    outline = [{ p: lo }, { p: { x: hi.x, y: lo.y } }, { p: hi }, { p: { x: lo.x, y: hi.y } }];
  }
  for (const c of cutouts) regions.push(encodeRegion({ layer: L.MULTI, outline: c, boardCutout: true }));
  const xs = outline.map((v) => v.p.x), ys = outline.map((v) => v.p.y);
  const boardRec = newBoardRecord({ fileName: `${name}.PcbDoc`, origin: P({ x: 0, y: 0 }), outline: outline as Edge[],
    sheet: { x: 0, y: 0, width: Math.max(...xs) + mil(2000), height: Math.max(...ys) + mil(2000) }, mechanical: [...mechNames.keys()] });
  for (const [m, nm] of mechNames) boardRec.set(`LAYER${mechLayer(m)}NAME`, nm);
  pourRank.sort((a, b) => a.rank - b.rank || a.index - b.index).forEach((o, i) => polygons[o.index]!.set('POURINDEX', String(i)));

  /* ── net classes and design rules ── */
  const classes = kidsOf(kid(board, 'NetClasses'), 'NetClass');
  const prop = (c: XEl | undefined) => kid(kid(c, 'LayProperties'), 'LayProperty');
  const lenOr = (e: XEl | undefined, a: string, d: number) => { const v = dnum(e, a, -1); return v > 0 ? v * K : d; };
  const def = prop(classes[0]);
  const routing = kid(settings, 'Routing');
  const rset = (k: string, d: number) => { const v = Number(dtext(routing, k).replace(',', '.')); return dtext(routing, k) && Number.isFinite(v) && v > 0 ? v * K : d; };
  const vs0 = viaStyles[0];
  const viaDrill = vs0 ? dnum(vs0, 'HoleSize') * K : rset('ViaHole', 0.3), viaDia = vs0 ? dnum(vs0, 'Size') * K : rset('ViaSize', 0.6);
  const size = kid(kid(kid(board, 'DRC'), 'LaySizes'), 'LaySize');
  const netClassOf = (n: XEl) => dnum(n, 'NetClass', 0);
  const clearance = lenOr(def, 'Clearance', rset('TraceClearance', 0.2));
  const { rules, classes: classBags } = boardRules({
    clearance, minTrack: lenOr(def, 'MinWidth', lenOr(size, 'MinTrace', 0.15)), trackWidth: lenOr(def, 'Width', rset('TraceWidth', 0.25)),
    viaDrill, viaDiameter: viaDia, minDrill: lenOr(size, 'MinDrill', Math.min(viaDrill, 0.2)),
    classes: classes.slice(1).map((c, ci) => ({
      name: dtext(c, 'Name') || `Class${ci + 1}`, trackWidth: lenOr(prop(c), 'Width', 0) || undefined, clearance: lenOr(prop(c), 'Clearance', 0) || undefined,
      nets: netEls.filter((n) => netClassOf(n) === ci + 1).map((n) => nets[netOf(dnum(n, 'Id', -1)) ?? -1]!).filter(Boolean),
    })),
  }, nets, nets);
  const rule = (kindName: string) => rules.find((r) => r.bag.get('RULEKIND') === kindName);
  const mmS = (v: number) => `${Math.round(v * 10000) / 10000}mm`;
  const swell = Number(dtext(settings, 'SolderMaskSwell').replace(',', '.')), shrink = Number(dtext(settings, 'PasteMaskShrink').replace(',', '.'));
  if (dtext(settings, 'SolderMaskSwell') && Number.isFinite(swell)) rule('SolderMaskExpansion')?.bag.set('EXPANSION', mmS(swell * K));
  if (dtext(settings, 'PasteMaskShrink') && Number.isFinite(shrink)) rule('PasteMaskExpansion')?.bag.set('EXPANSION', mmS(-shrink * K));
  let prio = 1;
  const extra = [] as typeof rules;
  for (const [v, names] of pourClear) {
    if (v <= clearance + 1e-6) continue;
    const r = newRule('Clearance', `PourClearance_${String(v).replace('.', '_')}mm`, prio++);
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
  // The stack: copper names and thicknesses, the dielectrics between, the planes' nets
  const items = kidsOf(kid(board, 'LayerStackItems'), 'LayerStackItem');
  const mat = (it?: XEl) => kid(it, 'Material');
  const copper: StackCopper[] = layList.map((l) => {
    const it = items.find((q) => dnum(q, 'Lay', -99) === dnum(l, 'Id') && mat(q)?.attrs.Type !== 'Dielectric');
    const t = dnum(mat(it), 'Thickness') * K;
    const pn = l.attrs.Type === 'Plane' ? netOf(dnum(l, 'NetId', -1)) : undefined;
    return { name: dtext(l, 'Name') || undefined, thickness: t > 0 ? mm(t) : undefined, plane: l.attrs.Type === 'Plane' && l !== layList[0] && l !== layList.at(-1), net: pn !== undefined ? nets[pn] : undefined };
  });
  const diels: StackDielectric[] = items.filter((q) => mat(q)?.attrs.Type === 'Dielectric').map((q) => ({ thickness: dnum(mat(q), 'Thickness') > 0 ? mm(dnum(mat(q), 'Thickness') * K) : undefined, er: dnum(mat(q), 'Constant') || undefined, material: dtext(mat(q), 'Name') || undefined }));
  applyStackLayers(pcbDoc, copper, diels.length === layList.length - 1 ? diels : []);
  if (layList.some((l, i) => l.attrs.Type === 'Plane' && (i === 0 || i === layList.length - 1))) warnOnce('Plane layers on the outside made signal layers');
  for (const [m, nm] of mechNames) pcbDoc.board.layerNames.set(mechLayer(m), nm);
  for (let i = 0; i < polygons.length; i++) repour(pcbDoc, i).apply();
  if (polygons.length && !opts.patterns) warnings.push(`${polygons.length} copper pour${polygons.length === 1 ? '' : 's'} poured with the board's rules (DipTrace's XML keeps no poured copper)`);
  for (const [k2, c] of tally) warnings.push(`Left out: ${k2} (${c})`);
  const footprints = footprintsFromBoard(pcbDoc);
  return { bytes: writePcbDoc(pcbDoc), name, footprints, warnings, stats: { components: nComps, pads: nPads, vias: nVias, tracks: nTracks, nets: nets.length, layers: layList.length, pours: polygons.length } };
}

/** A pattern library's (or a design cache's) patterns as footprints: each placed alone, read back as the library's. */
export function dipTraceFootprintLibrary(doc: DtDoc, styles?: string[]): { footprints: FootprintDef[]; warnings: string[] } {
  const list = styles ?? [...doc.patterns.keys()];
  if (!list.length) return { footprints: [], warnings: [] };
  const r = convertDipTracePcb({ ...doc, body: undefined }, 'Footprints', { patterns: list });
  return { footprints: r.footprints, warnings: r.warnings.filter((w) => !/board outline|poured/i.test(w)) };
}
