/**
 * AD boards as EasyEDA Standard's (a PCB document, docType 3, in its JSON): the copper stack (top,
 * the inner layers in order as Inner1…, internal planes as their copper poured, bottom),
 * silkscreens, pastes, masks, the board shape on BoardOutLine (cut-outs as board holes), the
 * assembly layers (mechanical layers named so) and the other mechanical layers on Document;
 * components as footprints with their pads (round, oval, rectangular, rounded and octagonal as
 * polygons), holes and slots, plating, mask and paste expansions, graphics, copper, designator
 * and comment, placed as AD places them (EasyEDA keeps footprints as placed); tracks, arcs, vias,
 * regions, fills, polygon pours (with their poured copper), keep-outs (as no-pour areas), text
 * with its strokes, dimensions; the design rules' clearance, track width and via. EasyEDA's unit
 * is 10 mil, Y down; AD's origin is its origin.
 */
import type { Vec2 } from '../../core/geom';
import { mil } from '../../core/units';
import { L, isMech, isPlane, mechNumber, type LayerId } from '../../model/layers';
import { NO_NET, slotEnds, type PcbComponent, type PcbDocument, type PcbPad, type PcbPrim, type PcbText, type PolyVertex } from '../../model/pcb';
import { planeCopper } from '../../model/planes';
import { dimensionEdges, dimensionGeometry } from '../../model/dimensions';
import { padOutline } from '../gerber/gerber';
import { strokeCapHeight, strokeText } from '../gerber/stroke';
import { PAD, get } from '../altium/pcbLayouts';
import { ruleEnabled, ruleKind, ruleLength, ruleScope1, ruleScope2 } from '../altium/rules';
import { fieldText, fmt, toBacktick } from './common';

export interface StdPcbExport { json: Record<string, unknown>; bytes: Uint8Array; warnings: string[]; stats: { components: number; nets: number; layers: number } }

/** EasyEDA's origin (as its own boards sit, round 4000, 3000). */
const OX = 4000, OY = 3000;
const U = 100_000;
const norm = (a: number) => ((a % 360) + 360) % 360;
const rad = (d: number) => (d * Math.PI) / 180;

/** An id a unique ID (or any key) gives, as EasyEDA's footprint ids look (gge and 16 hex): the schematic's part and the board's footprint share it. */
export function easyedaLibId(key: string): string {
  let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
  for (let i = 0; i < key.length; i++) { const c = key.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 ^ c, 2246822507) + 0x7f4a7c15; }
  return `gge${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`;
}

/** EasyEDA's layer table (its ids, names, colours), each marked used or not. */
const LAYER_TABLE: [string, string, string, string][] = [
  ['1', 'TopLayer', '#FF0000', ''], ['2', 'BottomLayer', '#0000FF', ''], ['3', 'TopSilkLayer', '#FFCC00', ''], ['4', 'BottomSilkLayer', '#66CC33', ''],
  ['5', 'TopPasteMaskLayer', '#808080', ''], ['6', 'BottomPasteMaskLayer', '#800000', ''], ['7', 'TopSolderMaskLayer', '#800080', '0.3'], ['8', 'BottomSolderMaskLayer', '#AA00FF', '0.3'],
  ['9', 'Ratlines', '#6464FF', ''], ['10', 'BoardOutLine', '#FF00FF', ''], ['11', 'Multi-Layer', '#C0C0C0', ''], ['12', 'Document', '#FFFFFF', ''],
  ['13', 'TopAssembly', '#33CC99', ''], ['14', 'BottomAssembly', '#5555FF', ''], ['15', 'Mechanical', '#F022F0', ''], ['19', '3DModel', '#66CCFF', ''],
];
const OBJECTS = ['All~true~false', 'Component~true~true', 'Prefix~true~true', 'Name~true~false', 'Track~true~true', 'Pad~true~true', 'Via~true~true', 'Hole~true~true',
  'Copper_Area~true~true', 'Circle~true~true', 'Arc~true~true', 'Solid_Region~true~true', 'Text~true~true', 'Image~true~true', 'Rect~true~true', 'Dimension~true~true', 'Protractor~true~true'];

export function exportEasyedaPcb(doc: PcbDocument, name: string, ids?: Map<string, string>): StdPcbExport {
  const warnings: string[] = [];
  const tally = new Map<string, number>();
  const note = (w: string) => tally.set(w, (tally.get(w) ?? 0) + 1);
  const origin = doc.board.origin;
  const ex = (x: number) => OX + (x - origin.x) / U, ey = (y: number) => OY - (y - origin.y) / U;
  const P = (p: Vec2) => `${fmt(ex(p.x))} ${fmt(ey(p.y))}`;
  const len = (v: number) => fmt(v / U);
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  const see = (p: Vec2) => { const x = ex(p.x), y = ey(p.y); bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); by0 = Math.min(by0, y); by1 = Math.max(by1, y); };
  let n = 1;
  const id = () => `gge${n++}`;
  const netName = (i: number) => (i === NO_NET || i < 0 ? '' : fieldText(doc.nets[i]?.name ?? ''));

  /* ── layers: the copper stack in order, the inner ones Inner1… ── */
  const stack = doc.board.copperStack.length ? doc.board.copperStack : [L.TOP, L.BOTTOM];
  const innerOf = new Map<LayerId, number>();
  stack.slice(1, -1).forEach((l, i) => { if (i < 32) innerOf.set(l, 21 + i); });
  const mechTo = (l: LayerId): number => {
    const nm = doc.board.layerNames.get(l) ?? '';
    if (/assembly|assy/i.test(nm)) return /bot/i.test(nm) ? 14 : 13;
    if (mechNumber(l) === 13) return 13;
    if (mechNumber(l) === 14) return 14;
    return 12;
  };
  const layerOf = (l: LayerId): number | null => {
    if (l === L.TOP || l === stack[0]) return 1;
    if (l === L.BOTTOM || l === stack.at(-1)) return 2;
    const inner = innerOf.get(l);
    if (inner) return inner;
    switch (l) {
      case L.TOP_OVERLAY: return 3; case L.BOTTOM_OVERLAY: return 4; case L.TOP_PASTE: return 5; case L.BOTTOM_PASTE: return 6;
      case L.TOP_SOLDER: return 7; case L.BOTTOM_SOLDER: return 8; case L.MULTI: return 11;
      default: return isMech(l) ? mechTo(l) : null;
    }
  };
  const copperIds = new Set<number>([1, 2, ...innerOf.values()]);

  const shapes: string[] = [];
  const pathOf = (pts: Vec2[], close = true) => { for (const p of pts) see(p); return `M ${pts.map(P).join(' L ')}${close ? ' Z' : ''}`; };
  const regionPath = (outline: Vec2[], holes: Vec2[][] = []) => [outline, ...holes].filter((r) => r.length >= 3).map((r) => pathOf(r)).join(' ');
  /** An arc as EasyEDA's SVG path: anticlockwise on screen (AD's way) is sweep 0. */
  const arcPath = (c: Vec2, r: number, start: number, end: number): string => {
    const span = norm(end - start) || 360;
    const at = (a: number) => ({ x: c.x + r * Math.cos(rad(a)), y: c.y + r * Math.sin(rad(a)) });
    if (span >= 359.999) return `M ${P(at(start))} A ${len(r)} ${len(r)} 0 1 0 ${P(at(start + 180))} A ${len(r)} ${len(r)} 0 1 0 ${P(at(start))}`;
    for (const a of [start, start + span / 2, start + span]) see(at(a));
    return `M ${P(at(start))} A ${len(r)} ${len(r)} 0 ${span > 180 ? 1 : 0} 0 ${P(at(start + span))}`;
  };

  /* ── the design rules' defaults ── */
  const general = (kind: string) => doc.rules.filter((r) => ruleKind(r) === kind && ruleEnabled(r) && /^\s*All\s*$/i.test(ruleScope1(r)) && /^\s*All\s*$/i.test(ruleScope2(r) || 'All'))[0];
  const clr = general('Clearance'), wid = general('Width'), via = general('RoutingVias'), smask = general('SolderMaskExpansion'), pmask = general('PasteMaskExpansion');
  const gap = clr ? ruleLength(clr, 'GAP', '10mil') : mil(10);
  const maskDefault = smask ? ruleLength(smask, 'EXPANSION', '4mil') : mil(4);
  const pasteDefault = pmask ? ruleLength(pmask, 'EXPANSION', '0mil') : 0;

  /* ── one primitive, owned by `comp` (its footprint's) or the board's ── */
  const textShape = (t: PcbText, kind: string, shown: boolean): string | null => {
    const layer = layerOf(t.layer);
    if (layer === null || layer === 11) { note('Text on layers EasyEDA has none of'); return null; }
    if (t.fontType === 2) note('Barcode text written as plain text');
    // Its strokes as EasyEDA keeps them (it draws them again on edit)
    const strokes = strokeText(t.text, t.at, strokeCapHeight(t), t.rotation, t.mirrored).filter((s) => s.length >= 2).map((s) => pathOf(s, false)).join(' ');
    see(t.at);
    return ['TEXT', kind, fmt(ex(t.at.x)), fmt(ey(t.at.y)), len(Math.max(t.strokeWidth, mil(1))), fmt(norm(t.rotation)), t.mirrored ? '1' : '0', layer, '', fmt(t.height / 0.8 / U),
      fieldText(t.text), strokes, shown ? '' : 'none', id(), t.fontType === 1 ? fieldText(t.fontName) : '', '0', kind === 'L' ? '' : 'pinpart'].join('~');
  };
  const padShape = (p: PcbPad): string | null => {
    if (p.jumper) note('Jumpers (pads joined by a Jumper ID) have no EasyEDA counterpart: their pads are left unjoined');
    const multi = p.layer === L.MULTI;
    const layer = multi ? 11 : layerOf(p.layer);
    if (layer === null) { note('Pads on layers EasyEDA has none of'); return null; }
    const st = multi ? p.top : p.layer === L.BOTTOM ? (p.bot.w ? p.bot : p.top) : p.top;
    if (multi && (p.mid.w !== p.top.w || p.mid.h !== p.top.h || p.bot.w !== p.top.w || p.bot.h !== p.top.h || p.bot.shape !== p.top.shape)) note('Pads with other sizes on their inner or bottom layers: written with their top size');
    const w = Math.max(st.w, p.hole), h = Math.max(st.h, p.hole);
    let shape = 'RECT', pts = '';
    if (st.shape === 'round' && Math.abs(w - h) < 2) shape = 'ELLIPSE';
    else if (st.shape === 'round') {
      shape = 'OVAL';
      const half = Math.abs(w - h) / 2, a = rad(p.rotation + (w >= h ? 0 : 90));
      const d = { x: Math.cos(a) * half, y: Math.sin(a) * half };
      pts = `${P({ x: p.at.x - d.x, y: p.at.y - d.y })} ${P({ x: p.at.x + d.x, y: p.at.y + d.y })}`;
    } else if (st.shape === 'rect') pts = padOutline(p.at, { ...st, w, h }, p.rotation).map(P).join(' ');
    else { shape = 'POLYGON'; pts = padOutline(p.at, { ...st, w, h }, p.rotation).map(P).join(' '); }
    see(p.at);
    const slot = slotEnds(p);
    // Its mask and paste expansions: as specified, else the rules'
    const raw = doc.streams.get(p.src.storage)?.records[p.src.index]?.subs[4];
    const maskMode = raw ? get(raw, PAD.solderMode) : 0, pasteMode = raw ? get(raw, PAD.pasteMode) : 0;
    const mask = raw && maskMode === 2 ? get(raw, PAD.solderManual) ?? maskDefault : maskDefault;
    const paste = multi ? 0 : raw && pasteMode === 2 ? get(raw, PAD.pasteManual) ?? pasteDefault : pasteDefault;
    const plain = p.hole > 0 && !p.plated && st.w <= p.hole && st.h <= p.hole;
    // An unnamed unplated hole is EasyEDA's hole; a named one stays a pad (its name kept)
    if (plain && !slot && !p.name.trim()) { see(p.at); return ['HOLE', fmt(ex(p.at.x)), fmt(ey(p.at.y)), len(p.hole / 2), id(), '0'].join('~'); }
    return ['PAD', shape, fmt(ex(p.at.x)), fmt(ey(p.at.y)), len(w), len(h), layer, netName(p.net), fieldText(p.name), len(p.hole / 2), pts, fmt(norm(p.rotation)), id(),
      slot ? len(p.slot!.length) : '0', slot ? `${P(slot[0])} ${P(slot[1])}` : '', p.hole > 0 ? (p.plated ? 'Y' : 'N') : '', '0', len(paste), len(mask), `${fmt(ex(p.at.x))},${fmt(ey(p.at.y))}`].join('~');
  };
  const primShape = (q: PcbPrim, inComp: boolean): string | null => {
    switch (q.kind) {
      case 'track': {
        if (q.polygon !== NO_NET && q.polygon >= 0 && q.polygon !== 0xffff) return null;
        if (isPlane(q.layer)) { note('Split lines on internal planes left out (the planes are written as their copper)'); return null; }
        if (q.layer === L.KEEPOUT || q.keepout) { note('Keep-out lines left out (EasyEDA keeps out by areas)'); return null; }
        const layer = layerOf(q.layer);
        if (layer === null) { note('Lines on layers EasyEDA has none of'); return null; }
        see(q.a); see(q.b);
        return ['TRACK', len(q.width), layer, copperIds.has(layer) && !inComp ? netName(q.net) : '', `${P(q.a)} ${P(q.b)}`, id(), q.locked ? '1' : '0'].join('~');
      }
      case 'arc': {
        if (q.polygon !== NO_NET && q.polygon >= 0 && q.polygon !== 0xffff) return null;
        if (isPlane(q.layer)) { note('Split lines on internal planes left out (the planes are written as their copper)'); return null; }
        if (q.layer === L.KEEPOUT || q.keepout) { note('Keep-out lines left out (EasyEDA keeps out by areas)'); return null; }
        const layer = layerOf(q.layer);
        if (layer === null) { note('Lines on layers EasyEDA has none of'); return null; }
        const net = copperIds.has(layer) && !inComp ? netName(q.net) : '';
        if ((norm(q.end - q.start) || 360) >= 359.999) { see(q.c); return ['CIRCLE', fmt(ex(q.c.x)), fmt(ey(q.c.y)), len(q.r), len(q.width), layer, id(), '0', net, ''].join('~'); }
        return ['ARC', len(q.width), layer, net, arcPath(q.c, q.r, q.start, q.end), '', id(), q.locked ? '1' : '0'].join('~');
      }
      case 'via':
        see(q.at);
        if ((q.layerStart !== L.TOP && q.layerStart !== stack[0]) || (q.layerEnd !== L.BOTTOM && q.layerEnd !== stack.at(-1))) note('Blind and buried vias written as through vias');
        return ['VIA', fmt(ex(q.at.x)), fmt(ey(q.at.y)), len(q.diameter), netName(q.net), len(q.hole / 2), id(), q.locked ? '1' : '0'].join('~');
      case 'pad': return padShape(q);
      case 'fill': {
        if (isPlane(q.layer)) { note('Shapes on internal planes left out (the planes are written as their copper)'); return null; }
        const layer = q.layer === L.KEEPOUT ? null : layerOf(q.layer);
        const c = { x: (q.a.x + q.b.x) / 2, y: (q.a.y + q.b.y) / 2 }, hw = Math.abs(q.b.x - q.a.x) / 2, hh = Math.abs(q.b.y - q.a.y) / 2;
        const pts = padOutline(c, { w: hw * 2, h: hh * 2, shape: 'rect', cornerPct: 0 }, q.rotation);
        if (layer === null || q.keepout) return keepout(pts, q.layer);
        return ['SOLIDREGION', layer, copperIds.has(layer) && !inComp ? netName(q.net) : '', regionPath(pts), 'solid', id(), '', '', '', q.locked ? '1' : '0'].join('~');
      }
      case 'region': {
        if (q.polygon !== NO_NET && q.polygon >= 0 && q.polygon !== 0xffff) return null;
        if (q.boardCutout) return ['SOLIDREGION', 11, '', regionPath(q.outline), 'npth', id(), '', '', '', '0'].join('~');
        if (q.layer === L.KEEPOUT || q.keepout) return keepout(q.outline, q.layer);
        if (isPlane(q.layer)) { note('Shapes on internal planes left out (the planes are written as their copper)'); return null; }
        const layer = layerOf(q.layer);
        if (layer === null) { note('Regions on layers EasyEDA has none of'); return null; }
        if (q.regionKind === 1) return ['SOLIDREGION', layer, '', regionPath(q.outline, q.holes), 'cutout', id(), '', '', '', '0'].join('~');
        if (q.regionKind !== 0) return null;
        return ['SOLIDREGION', layer, copperIds.has(layer) && !inComp ? netName(q.net) : '', regionPath(q.outline, q.holes), 'solid', id(), '', '', '', q.locked ? '1' : '0'].join('~');
      }
      case 'text': return q.isDesignator || q.isComment ? null : textShape(q, 'L', !q.hidden);
      case 'body': return null;
      default: return null;
    }
  };
  /** A keep-out: EasyEDA's no-pour area on the copper it keeps out of. */
  function keepout(pts: Vec2[], layer: LayerId): string | null {
    note('Keep-outs written as no-pour areas (EasyEDA\'s cut-outs)');
    const on = layer === L.KEEPOUT ? [...copperIds] : [layerOf(layer)].filter((x): x is number => x !== null && copperIds.has(x));
    if (!on.length) return null;
    return on.map((l) => ['SOLIDREGION', l, '', regionPath(pts), 'cutout', id(), '', '', '', '0'].join('~')).join('\u0001');
  }
  const push = (s: string | null) => { if (s) for (const part of s.split('\u0001')) shapes.push(part); };

  /* ── the board shape: its edges on BoardOutLine ── */
  const vs = doc.board.vertices.length ? doc.board.vertices : doc.board.outline.map((p): PolyVertex => ({ p }));
  vs.forEach((v, i) => {
    const nx = vs[(i + 1) % vs.length]!;
    if (v.arc) {
      // The edge from here to the next: the way round the arc that runs from here to there
      const a0 = (Math.atan2(v.p.y - v.arc.c.y, v.p.x - v.arc.c.x) * 180) / Math.PI;
      const a1 = (Math.atan2(nx.p.y - v.arc.c.y, nx.p.x - v.arc.c.x) * 180) / Math.PI;
      const ccw = Math.abs(norm(a0) - norm(v.arc.sa)) < 0.5;
      shapes.push(['ARC', '1', '10', '', ccw ? arcPath(v.arc.c, v.arc.r, a0, a1) : arcPath(v.arc.c, v.arc.r, a1, a0), '', id(), '0'].join('~'));
    } else { see(v.p); see(nx.p); shapes.push(['TRACK', '1', '10', '', `${P(v.p)} ${P(nx.p)}`, id(), '0'].join('~')); }
  });

  /* ── the board's own primitives ── */
  for (const q of doc.prims) if (!('component' in q) || q.component === NO_NET || q.component < 0 || q.component === 0xffff) push(primShape(q, false));

  /* ── internal planes: their copper as copper areas ── */
  for (const l of stack.filter(isPlane)) {
    const layer = innerOf.get(l);
    if (!layer) continue;
    // A plane of one net: a copper area of the board's shape, EasyEDA pours it (Rebuild Copper Area)
    if (!doc.polygons.some((pg) => pg.layer === l && /split/i.test(pg.type))) {
      const nm = doc.board.bag?.get(`PLANE${l - L.PLANE1 + 1}NETNAME`) ?? '';
      const ni = doc.nets.findIndex((x) => x.name === nm);
      const outline = doc.board.outline.length >= 3 ? doc.board.outline : [];
      if (ni >= 0 && outline.length) {
        shapes.push(['COPPERAREA', '1', layer, netName(ni), regionPath(outline), len(gap), 'solid', id(), 'spoke', 'none', '[[]]', '0', id(), '0', '1', '2', '1', 'yes', '0'].join('~'));
        note('Internal planes written as copper areas on inner signal layers, to pour in EasyEDA (Rebuild Copper Area)');
      }
      continue;
    }
    for (const a of planeCopper(doc, l)) for (const r of a.regions) {
      shapes.push(['COPPERAREA', '1', layer, netName(a.net), regionPath(r.outline), len(gap), 'solid', id(), 'spoke', 'none', JSON.stringify([[regionPath(r.outline, r.holes)]]), '0', id(), '0', '1', '2', '1', 'yes', '0'].join('~'));
    }
    note('Internal planes written as copper areas on inner signal layers');
  }

  /* ── polygon pours, with their poured copper ── */
  const pourRegions = new Map<number, Extract<PcbPrim, { kind: 'region' }>[]>();
  for (const q of doc.prims) if (q.kind === 'region' && q.polygon !== NO_NET && q.polygon >= 0) { const l = pourRegions.get(q.polygon) ?? []; l.push(q); pourRegions.set(q.polygon, l); }
  for (const pg of doc.polygons) {
    if (pg.type && !/^polygon$/i.test(pg.type)) continue;
    const layer = layerOf(pg.layer);
    if (layer === null || !copperIds.has(layer) || pg.outline.length < 3) continue;
    const islands = (pourRegions.get(pg.index) ?? []).map((q) => regionPath(q.outline, q.holes));
    const removeDead = (pg.bag.get('REMOVEDEAD') ?? 'TRUE').toUpperCase() !== 'FALSE';
    shapes.push(['COPPERAREA', len(Math.max(mil(1), Number.parseFloat(pg.bag.get('TRACKWIDTH') ?? '8') * 10000 || mil(8))), layer, netName(pg.net), regionPath(pg.outline), len(gap), 'solid', id(), 'spoke',
      removeDead ? 'none' : 'yes', JSON.stringify([islands]), '0', id(), String(pg.bag.int('POURINDEX', pg.index)), '1', '2', '1', 'yes', '0'].join('~'));
    if (pg.hatch && !/^solid$/i.test(pg.hatch)) note('Hatched pours written solid');
  }

  /* ── footprints: placed as on the board ── */
  const byComp = new Map<number, PcbPrim[]>();
  for (const q of doc.prims) if ('component' in q && q.component !== NO_NET && q.component >= 0 && q.component !== 0xffff) { const l = byComp.get(q.component) ?? []; l.push(q); byComp.set(q.component, l); }
  for (const c of doc.components) shapes.push(footprint(c, byComp.get(c.index) ?? []));

  function footprint(c: PcbComponent, prims: PcbPrim[]): string {
    const bottom = c.layer === L.BOTTOM;
    const uid = (c.bag.get('SOURCEUNIQUEID') ?? '').replace(/^\\+/, '');
    const libRef = c.bag.get('SOURCELIBREFERENCE') ?? '';
    const prefix = c.designator.replace(/\d.*$/, '');
    const para = toBacktick([['package', c.pattern], ['link', ''], ['spicePre', prefix], ['spiceSymbolName', libRef], ['Contributor', 'Konium Designer']]);
    see(c.at);
    // EasyEDA turns a bottom footprint after mirroring it left to right: its turn is AD's less half a turn
    const rot = norm(bottom ? c.rotation - 180 : c.rotation);
    const subs: string[] = [];
    for (const q of prims) { const s = q.kind === 'text' ? null : primShape(q, true); if (s) for (const part of s.split('\u0001')) subs.push(part); }
    const des = prims.find((q): q is PcbText => q.kind === 'text' && q.isDesignator);
    const com = prims.find((q): q is PcbText => q.kind === 'text' && q.isComment);
    const other = prims.filter((q): q is PcbText => q.kind === 'text' && !q.isDesignator && !q.isComment);
    const ov = bottom ? L.BOTTOM_OVERLAY : L.TOP_OVERLAY;
    const stub = (text: string): PcbText => ({ kind: 'text', src: { storage: '', index: -1 }, layer: ov, at: c.at, height: mil(40), rotation: 0, mirrored: bottom, strokeWidth: mil(6), text, component: c.index, isComment: false, isDesignator: false, fontType: 0, fontName: '', bold: false, italic: false, hidden: true });
    const t1 = textShape(des ? { ...des, text: c.designator || des.text } : stub(c.designator), 'P', c.nameOn);
    const t2 = textShape(com ?? stub(c.bag.get('SOURCEDESCRIPTION') ?? c.pattern), 'N', c.commentOn);
    for (const t of [t1, t2, ...other.map((o) => textShape(o, 'L', !o.hidden))]) if (t) subs.push(t);
    const head = ['LIB', fmt(ex(c.at.x)), fmt(ey(c.at.y)), para, fmt(rot), '', ids?.get(c.designator) ?? (uid ? easyedaLibId(uid) : easyedaLibId(`des:${c.designator}`)), bottom ? '2' : '1',
      easyedaLibId(`fp:${c.pattern}`).slice(3) + easyedaLibId(`fp2:${c.pattern}`).slice(3), String(Math.floor(Date.now() / 1000)), c.bag.get('LOCKED') === 'TRUE' ? '1' : '0', '', 'yes', '', ''].join('~');
    return [head, ...subs].join('#@$');
  }

  /* ── dimensions: their lines and value ── */
  const edgeOf = dimensionEdges(doc.prims);
  for (const d of doc.dimensions) {
    const layer = layerOf(d.layer);
    if (layer === null) continue;
    const g = dimensionGeometry(d, false, edgeOf);
    for (const l of g.lines) { see(l.a); see(l.b); shapes.push(['TRACK', len(l.w), layer, '', `${P(l.a)} ${P(l.b)}`, id(), '0'].join('~')); }
    for (const a of g.arcs) shapes.push(['ARC', len(a.w), layer, '', arcPath(a.c, a.r, a.start, a.end), '', id(), '0'].join('~'));
    for (const t of g.texts) { const s = textShape({ kind: 'text', src: { storage: '', index: -1 }, layer: d.layer, at: t.at, height: t.height, rotation: t.rotation, mirrored: t.mirrored, strokeWidth: t.w, text: t.text, component: -1, isComment: false, isDesignator: false, fontType: 0, fontName: '', bold: false, italic: false, hidden: false }, 'L', true); if (s) shapes.push(s); }
  }

  /* ── the document ── */
  if (!Number.isFinite(bx0)) { bx0 = OX; by0 = OY; bx1 = OX + 100; by1 = OY + 100; }
  const usedInner = new Map([...innerOf].map(([l, i]) => [i, l]));
  const layers = [
    ...LAYER_TABLE.map(([lid, nm, colour, extra]) => `${lid}~${nm}~${colour}~true~${lid === '1' ? 'true' : 'false'}~${Number(lid) <= 12 ? 'true' : 'false'}~${extra}`),
    ...Array.from({ length: 32 }, (_, i) => {
      const lid = 21 + i, l = usedInner.get(lid);
      return l !== undefined ? `${lid}~${fieldText((doc.board.layerNames.get(l) ?? `Inner${i + 1}`).replace(/~/g, '-'))}~#999966~true~false~true~0~Signal` : `${lid}~Inner${i + 1}~#999966~false~false~false~`;
    }),
    '99~ComponentShapeLayer~#00CCCC~false~false~false~0.4', '100~LeadShapeLayer~#CC9999~false~false~false~', '101~ComponentMarkingLayer~#66FFCC~false~false~false~',
    'Hole~Hole~#222222~false~false~true~', 'DRCError~DRCError~#FAD609~false~false~true~',
  ];
  const json = {
    head: { docType: '3', editorVersion: '6.5.34', newgId: true, c_para: {}, x: String(OX), y: String(OY), hasIdFlag: true, importFlag: 0, transformList: '', title: name },
    canvas: `CA~1000~1000~#000000~yes~#FFFFFF~10~1000~1000~line~0.5~mil~1~45~visible~0.5~${OX}~${OY}~0~yes`,
    shape: shapes,
    layers,
    objects: OBJECTS,
    BBox: { x: fmt(bx0), y: fmt(by0), width: fmt(bx1 - bx0), height: fmt(by1 - by0) },
    preference: { hideFootprints: '', hideNets: '' },
    DRCRULE: {
      Default: { trackWidth: Number(len(wid ? ruleLength(wid, 'PREFEREDWIDTH', '10mil') : mil(10))), clearance: Number(len(gap)),
        viaHoleDiameter: Number(len(via ? ruleLength(via, 'WIDTH', '50mil') : mil(24))), viaHoleD: Number(len(via ? ruleLength(via, 'HOLEWIDTH', '28mil') : mil(12))) },
      isRealtime: false, isDrcOnRoutingOrPlaceVia: false, checkObjectToCopperarea: true, showDRCRangeLine: true,
    },
    netColors: {},
  };
  for (const [k, c] of tally) warnings.push(c > 1 ? `${k} (${c})` : k);
  const text = JSON.stringify(json);
  return { json, bytes: new TextEncoder().encode(text), warnings, stats: { components: doc.components.length, nets: doc.nets.length, layers: stack.length } };
}
