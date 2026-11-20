/**
 * EasyEDA Standard boards (PCB documents, docType 3; a footprint document, docType 4, read the
 * same way) as AD's: the copper stack (top, the inner layers in use, bottom), silkscreens, masks,
 * pastes, the board outline (BoardOutLine's tracks and arcs joined into the board shape, the other
 * loops cut-outs) also on Mechanical 1, the documentation layers on mechanical layers with their
 * names; footprints (LIB) as components with their pads, graphics, designator and value (their
 * library footprints a PcbLib), pads by shape (rectangle, round, oval, polygon pads as copper),
 * holes, slots, plating and mask and paste expansions, vias, tracks and arcs by net, solid regions
 * (copper, cut-outs, board cut-outs, teardrops), copper areas as polygon pours with their poured
 * copper (unpoured ones poured by the board's rules), circles, rectangles, text, logos, dimensions,
 * the design rules' defaults. EasyEDA's unit is 10 mil, Y down; the board's lower left goes 1000
 * mil in from AD's sheet corner, AD's origin at EasyEDA's.
 */
import type { Vec2 } from '../../core/geom';
import { formatAltiumLength, mil, mm } from '../../core/units';
import { L, mechLayer, type LayerId } from '../../model/layers';
import type { PolyVertex } from '../../model/pcb';
import { footprintsFromBoard } from '../../model/pcbLib';
import { repour } from '../../model/pcbEdit';
import { newBoardRecord } from '../altium/board6';
import { assemblePcbDoc, applyStackLayers } from '../altium/assemble';
import { encodeArc, encodePad, encodeRegion, encodeText, encodeTrack, encodeVia, layerToName, writePcbDoc, writeVertices, type PadFields } from '../altium/pcbdoc';
import type { FootprintDef } from '../altium/pcblib';
import type { PcbRawRecord } from '../altium/framing';
import { PropertyBag } from '../altium/props';
import { altiumFloat } from '../altium/pcbTransform';
import { newPolygonProps } from '../altium/polygonProps';
import { boardRules, uniqueIdFor } from '../kicad/board';
import { arcCentre, at, backtick, fields, flattenSub, num, parsePath, pointList, textValue, type PathSeg } from './common';

export interface EasyedaPcbResult { bytes: Uint8Array; name: string; footprints: FootprintDef[]; warnings: string[]; stats: { components: number; pads: number; vias: number; tracks: number; nets: number; layers: number } }

/** EasyEDA's unit (10 mil) in AD's (1/10000 mil). */
const U = 100_000;
const norm = (a: number) => ((a % 360) + 360) % 360;
const COPPER = (id: number) => id === 1 || id === 2 || (id >= 21 && id <= 52);
/** EasyEDA's documentation layers on AD's mechanical layers (by number), with their names. */
const MECH: Record<number, [number, string]> = { 10: [1, 'BoardOutLine'], 12: [2, 'Document'], 15: [3, 'Mechanical'], 99: [4, 'ComponentShapeLayer'], 100: [5, 'LeadShapeLayer'], 101: [6, 'ComponentMarkingLayer'], 11: [7, 'Multi-Layer'], 13: [13, 'TopAssembly'], 14: [14, 'BottomAssembly'] };
const FIXED: Record<number, LayerId> = { 3: L.TOP_OVERLAY, 4: L.BOTTOM_OVERLAY, 5: L.TOP_PASTE, 6: L.BOTTOM_PASTE, 7: L.TOP_SOLDER, 8: L.BOTTOM_SOLDER };

/** Whether a JSON document is an EasyEDA Standard board (or footprint). */
export function easyedaDocType(doc: unknown): number {
  const d = doc as { docType?: unknown; head?: { docType?: unknown } };
  return num(d?.head?.docType as string, num(d?.docType as string, 0));
}

export function convertEasyedaPcb(doc: Record<string, unknown>, fileName: string): EasyedaPcbResult {
  const head = (doc.head ?? {}) as Record<string, unknown>;
  const shapes = (Array.isArray(doc.shape) ? doc.shape : []) as string[];
  const name = (String(head.title ?? '') || fileName.replace(/\.[^.]+$/, '').replace(/^PCB_/, '').replace(/_\d{4}-\d{2}-\d{2}$/, '')).replace(/[\\/:*?"<>|]/g, '_') || 'Board';
  const warnings: string[] = [];
  const hx = num(head.x as string), hy = num(head.y as string);

  /* ── layers: the inner ones the layer table enables or the shapes use ── */
  const layerRows = (Array.isArray(doc.layers) ? doc.layers : []) as string[];
  const layerName = new Map<number, string>();
  const inner = new Set<number>();
  for (const l of layerRows) { const f = fields(String(l)); const id = num(f[0], -1); if (id >= 0) layerName.set(id, f[1] ?? ''); if (id >= 21 && id <= 52 && f[5] === 'true') inner.add(id); }
  const recs = shapes.flatMap((s) => String(s).split('#@$'));
  for (const r of recs) {
    const f = fields(r), t = f[0];
    const lid = t === 'TRACK' || t === 'ARC' ? num(f[2]) : t === 'COPPERAREA' ? num(f[2]) : t === 'SOLIDREGION' ? num(f[1]) : t === 'PAD' ? num(f[6]) : t === 'CIRCLE' ? num(f[5]) : t === 'TEXT' ? num(f[7]) : t === 'RECT' ? num(f[5]) : 0;
    if (lid >= 21 && lid <= 52) inner.add(lid);
  }
  const innerIds = [...inner].sort((a, b) => a - b).slice(0, 30);
  const copperOrder = [1, ...innerIds, 2];
  const copperOf = new Map<number, LayerId>(copperOrder.map((id, i) => [id, (i === 0 ? L.TOP : i === copperOrder.length - 1 ? L.BOTTOM : (L.MID1 + i - 1)) as LayerId]));
  const mechNames = new Map<number, string>();
  const layerOf = (id: number): LayerId | null => {
    const c = copperOf.get(id);
    if (c !== undefined) return c;
    if (FIXED[id] !== undefined) return FIXED[id]!;
    const m = MECH[id];
    if (m) { if (!mechNames.has(m[0])) mechNames.set(m[0], layerName.get(id) || m[1]); return mechLayer(m[0]); }
    return null;
  };

  /* ── coordinates: EasyEDA's (10 mil, Y down) → AD's, the content's lower left 1000 mil in ── */
  let x0 = Infinity, y1 = -Infinity;
  const seeAll = (p: Vec2) => { if (p.x < x0) x0 = p.x; if (p.y > y1) y1 = p.y; };
  for (const r of recs) {
    const f = fields(r);
    switch (f[0]) {
      case 'TRACK': for (const p of pointList(at(f, 4))) seeAll(p); break;
      case 'PAD': case 'VIA': case 'HOLE': case 'LIB': seeAll({ x: num(f[f[0] === 'PAD' ? 2 : 1]), y: num(f[f[0] === 'PAD' ? 3 : 2]) }); break;
      case 'COPPERAREA': for (const sp of parsePath(at(f, 4))) seeAll(sp.start); break;
      default:
    }
  }
  const bb = doc.BBox as { x?: number; y?: number; width?: number; height?: number } | undefined;
  if (bb && Number.isFinite(Number(bb.x))) { seeAll({ x: num(bb.x), y: num(bb.y) + num(bb.height) }); }
  if (!Number.isFinite(x0)) { x0 = hx; y1 = hy; }
  x0 = Math.min(x0, hx); y1 = Math.max(y1, hy);
  const P = (p: Vec2): Vec2 => ({ x: Math.round(mil(1000) + (p.x - x0) * U), y: Math.round(mil(1000) + (y1 - p.y) * U) });
  const len = (v: number) => Math.max(0, Math.round(v * U));

  /* ── nets ── */
  const nets: string[] = [];
  const netIndex = new Map<string, number>();
  const netOf = (n: string | undefined, lid: number): number | undefined => {
    if (!n || !COPPER(lid) && lid !== 11) return undefined;
    if (/^S\$\d+$/.test(n)) return undefined;
    if (!netIndex.has(n)) { netIndex.set(n, nets.length); nets.push(n); }
    return netIndex.get(n);
  };

  const comps: PropertyBag[] = [];
  const pads: PcbRawRecord[] = [], tracks: PcbRawRecord[] = [], arcs: PcbRawRecord[] = [], vias: PcbRawRecord[] = [], regions: PcbRawRecord[] = [], texts: PcbRawRecord[] = [];
  const polygons: PropertyBag[] = [];
  const outlineEdges: { a: Vec2; b: Vec2; arc?: { c: Vec2; r: number; sa: number; ea: number } }[] = [];
  const pourOrder: { index: number; order: number; poured: boolean }[] = [];
  let nTracks = 0, nVias = 0;
  const tally = new Map<string, number>();
  const skip = (what: string) => tally.set(what, (tally.get(what) ?? 0) + 1);

  /** An SVG arc (in EasyEDA's frame) as AD's: centre, radius, its angles anticlockwise in AD's frame. */
  const adArc = (s: Extract<PathSeg, { kind: 'A' }>) => {
    const a = arcCentre(s);
    // Y flips: angles and sweeps change sign
    const A0 = -a.a0, S = -a.sweepDeg;
    const full = Math.abs(S) >= 359.99;
    const [start, end] = full ? [0, 360] : S >= 0 ? [A0, A0 + S] : [A0 + S, A0];
    return { c: P(a.c), r: len(a.r), start: full ? 0 : norm(start), end: full ? 360 : norm(end) || (norm(start) > 0 ? 360 : 0) };
  };
  /** A path's subpaths as AD outlines (arcs and curves stepped). */
  const rings = (d: string): Vec2[][] => parsePath(d).map((sp) => flattenSub(sp, 6).map(P)).filter((r) => r.length >= 3);

  /** One primitive (top level or a footprint's), `owner` the component it's in. */
  const prim = (rec: string, owner?: number): void => {
    const f = fields(rec);
    switch (f[0]) {
      case 'TRACK': {
        const lid = num(f[2]), w = len(num(f[1])), pts = pointList(at(f, 4)).map(P);
        const layer = layerOf(lid);
        if (layer === null) { skip(`layer ${lid}`); return; }
        const net = owner === undefined ? netOf(f[3], lid) : undefined;
        for (let i = 1; i < pts.length; i++) {
          tracks.push(encodeTrack({ layer, a: pts[i - 1]!, b: pts[i]!, width: Math.max(1, w), net, component: owner }));
          nTracks++;
          if (lid === 10) outlineEdges.push({ a: pts[i - 1]!, b: pts[i]! });
        }
        return;
      }
      case 'ARC': {
        const lid = num(f[2]), w = len(num(f[1]));
        const layer = layerOf(lid);
        if (layer === null) { skip(`layer ${lid}`); return; }
        const net = owner === undefined ? netOf(f[3], lid) : undefined;
        for (const sp of parsePath(at(f, 4))) for (const s of sp.segs) {
          if (s.kind === 'A') {
            const a = adArc(s);
            arcs.push(encodeArc({ layer, ...a, width: Math.max(1, w), net, component: owner })); nTracks++;
            if (lid === 10) outlineEdges.push({ a: P(s.a), b: P(s.b), arc: { c: a.c, r: a.r, sa: a.start, ea: a.end < a.start ? a.end + 360 : a.end } });
          } else if (s.kind === 'L') {
            tracks.push(encodeTrack({ layer, a: P(s.a), b: P(s.b), width: Math.max(1, w), net, component: owner })); nTracks++;
            if (lid === 10) outlineEdges.push({ a: P(s.a), b: P(s.b) });
          }
        }
        return;
      }
      case 'CIRCLE': {
        const lid = num(f[5]);
        const layer = layerOf(lid);
        if (layer === null) { skip(`layer ${lid}`); return; }
        const c = P({ x: num(f[1]), y: num(f[2]) }), r = len(num(f[3]));
        if (r <= 0) return;
        arcs.push(encodeArc({ layer, c, r, start: 0, end: 360, width: Math.max(1, len(num(f[4]))), net: owner === undefined ? netOf(f[8], lid) : undefined, component: owner }));
        if (lid === 10) { const a = { x: c.x + r, y: c.y }, b = { x: c.x - r, y: c.y }; outlineEdges.push({ a, b, arc: { c, r, sa: 0, ea: 180 } }, { a: b, b: a, arc: { c, r, sa: 180, ea: 360 } }); }
        return;
      }
      case 'RECT': {
        const lid = num(f[5]);
        const layer = layerOf(lid);
        if (layer === null) { skip(`layer ${lid}`); return; }
        const x = num(f[1]), y = num(f[2]), w = num(f[3]), h = num(f[4]);
        const corners = [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }].map(P);
        const net = owner === undefined ? netOf(f[11], lid) : undefined;
        if (f[9] && f[9] !== 'none') regions.push(encodeRegion({ layer, outline: corners, net, component: owner }));
        else for (let i = 0; i < 4; i++) tracks.push(encodeTrack({ layer, a: corners[i]!, b: corners[(i + 1) % 4]!, width: Math.max(1, len(num(f[8]))), net, component: owner }));
        if (lid === 10) for (let i = 0; i < 4; i++) outlineEdges.push({ a: corners[i]!, b: corners[(i + 1) % 4]! });
        return;
      }
      case 'VIA': {
        const at0 = P({ x: num(f[1]), y: num(f[2]) }), d = len(num(f[3])), hole = len(num(f[5]) * 2);
        if (owner !== undefined) { pads.push(encodePad({ name: '', layer: L.MULTI, at: at0, w: d, h: d, shape: 'round', hole, component: owner })); return; }
        vias.push(encodeVia({ at: at0, diameter: Math.max(d, hole + 1), hole, net: netOf(f[4], 1) })); nVias++;
        return;
      }
      case 'HOLE': {
        const d = len(num(f[3]) * 2);
        if (d > 0) pads.push(encodePad({ name: '', layer: L.MULTI, at: P({ x: num(f[1]), y: num(f[2]) }), w: d, h: d, shape: 'round', hole: d, plated: false, component: owner }));
        return;
      }
      case 'PAD': padOf(f, owner); return;
      case 'TEXT': {
        const lid = num(f[7]);
        const layer = layerOf(lid);
        const s = textValue(at(f, 10));
        if (layer === null || !s) return;
        const kind = f[1];
        texts.push(encodeText({ layer, at: P({ x: num(f[2]), y: num(f[3]) }), height: Math.max(mil(10), len(num(f[9]) * 0.8)), text: s, rotation: norm(num(f[5])), strokeWidth: Math.max(mil(1), len(num(f[4]))),
          mirrored: f[6] === '1', component: owner, isDesignator: owner !== undefined && kind === 'P', isComment: owner !== undefined && kind === 'N' }));
        return;
      }
      case 'SOLIDREGION': {
        const lid = num(f[1]), type = at(f, 4);
        for (const ring of rings(at(f, 3))) {
          if (lid === 11) { regions.push(encodeRegion({ layer: L.MULTI, outline: ring, boardCutout: true })); continue; }
          const layer = layerOf(lid);
          if (layer === null) { skip(`layer ${lid}`); continue; }
          if (type === 'cutout') regions.push(encodeRegion({ layer, outline: ring, kind: 1, component: owner }));
          else if (type === 'npth') regions.push(encodeRegion({ layer: L.MULTI, outline: ring, boardCutout: true }));
          else regions.push(encodeRegion({ layer, outline: ring, net: owner === undefined ? netOf(f[2], lid) : undefined, component: owner }));
        }
        return;
      }
      case 'COPPERAREA': pourOf(f); return;
      case 'SVGNODE': {
        let node: { nodeName?: string; nodeType?: number; layerid?: string; attrs?: Record<string, string>; childNodes?: unknown[] };
        try { node = JSON.parse(at(f, 1)); } catch { skip('SVGNODE (not JSON)'); return; }
        const lid = num(node.layerid ?? node.attrs?.layerid);
        if (lid === 19) return;   // a 3D model's outline
        const layer = layerOf(lid);
        if (layer === null) { skip(`layer ${lid}`); return; }
        const paths: string[] = [];
        const walk = (n: typeof node) => { if (n.nodeName === 'path' && n.attrs?.d) paths.push(n.attrs.d); for (const k of n.childNodes ?? []) walk(k as typeof node); };
        walk(node);
        for (const d of paths) {
          // Nested contours: an outline and the holes inside it
          const rs = rings(d);
          const area = (r: Vec2[]) => Math.abs(r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]!; return s + p.x * q.y - q.x * p.y; }, 0)) / 2;
          const sorted = rs.map((r) => ({ r, a: area(r) })).sort((a, b) => b.a - a.a);
          const outer: { r: Vec2[]; holes: Vec2[][] }[] = [];
          for (const { r } of sorted) {
            const host = outer.find((o) => insidePoly(r[0]!, o.r));
            if (host && !host.holes.some((h) => insidePoly(r[0]!, h))) host.holes.push(r); else outer.push({ r, holes: [] });
          }
          for (const o of outer) regions.push(encodeRegion({ layer, outline: o.r, holes: o.holes, component: owner }));
        }
        return;
      }
      case 'DIMENSION': {
        const layer = layerOf(num(f[1]));
        if (layer === null) return;
        const w = Math.max(1, len(num(f[7], 0.4)));
        for (const sp of parsePath(at(f, 2))) { const pts = flattenSub(sp).map(P); for (let i = 1; i < pts.length; i++) tracks.push(encodeTrack({ layer, a: pts[i - 1]!, b: pts[i]!, width: w })); }
        return;
      }
      case 'LIB': return;
      default: if (f[0]) skip(f[0]);
    }
  };

  /** A pad: its shape (polygon pads as copper round a small pad), hole or slot, layer, net. */
  function padOf(f: string[], owner?: number): void {
    const lid = num(f[6]);
    const centre = P({ x: num(f[2]), y: num(f[3]) });
    const w = len(num(f[4])), h = len(num(f[5])), rot = norm(num(f[11]));
    const holeR = num(f[9]), hole = holeR > 0 ? len(holeR * 2) : 0;
    const layer: LayerId | null = lid === 11 ? L.MULTI : layerOf(lid);
    if (layer === null || (w <= 0 && h <= 0)) { skip('pad'); return; }
    const net = netOf(f[7], lid === 11 ? 1 : lid);
    const shapeName = (f[1] ?? '').toUpperCase();
    let shape: PadFields['shape'] = shapeName === 'RECT' ? 'rect' : 'round';
    let pw = w, ph = h;
    if (shapeName === 'POLYGON') {
      // AD's pads have no polygon: the outline as copper, a pad within it
      const ring = pointList(at(f, 10)).map(P);
      const cu = layer === L.MULTI ? [...copperOf.values()].filter((l) => l === L.TOP || l === L.BOTTOM) : [layer];
      if (ring.length >= 3) for (const cl of cu) regions.push(encodeRegion({ layer: cl, outline: ring, net, component: owner }));
      pw = ph = Math.max(1, Math.round(Math.min(w, h) * 0.5));
      if (hole) pw = ph = Math.max(pw, hole + mil(4));
      shape = 'round';
    }
    // A slot: its length (the hole its width), along the line its ends give (else the pad's longer side)
    let slot: PadFields['slot'];
    const slotLen = len(num(f[13]));
    if (hole && slotLen > hole) {
      const e = pointList(at(f, 14));
      let dir = w >= h ? rot : rot + 90;
      if (e.length >= 2) { const a = P(e[0]!), b = P(e[1]!); if (Math.hypot(b.x - a.x, b.y - a.y) > 0) dir = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI; }
      slot = { length: slotLen, rotation: norm(dir - rot) };
    }
    const mask = at(f, 18) !== '' ? len(num(f[18])) : undefined;
    const pasteV = num(f[17]);
    const paste = at(f, 17) === '' || layer === L.MULTI ? undefined : pasteV <= -100 ? -Math.max(w, h) : len(pasteV);
    pads.push(encodePad({ name: at(f, 8), layer, at: centre, w: Math.max(1, pw), h: Math.max(1, ph), shape, rotation: rot, hole: hole || undefined, plated: hole ? f[15] !== 'N' : undefined,
      slot, net, component: owner, solderExpansion: mask, pasteExpansion: paste && paste !== 0 ? paste : undefined }));
  }

  /** A copper area: a polygon pour, its poured copper (islands with their holes) as its regions. */
  function pourOf(f: string[]): void {
    const lid = num(f[2]);
    const layer = copperOf.get(lid);
    if (layer === undefined) { skip('copper area off copper'); return; }
    const outline = parsePath(at(f, 4))[0];
    if (!outline) return;
    const pts = flattenSub(outline, 6).map(P);
    if (pts.length < 3) return;
    const net = f[3] && f[3] !== '0' ? netOf(f[3], lid) : undefined;
    const index = polygons.length;
    const bag = newPolygonProps(layerToName(layer), net ?? 0xffff, `${f[3] && f[3] !== '0' ? f[3] : 'No Net'}_${index + 1}`, index);
    writeVertices(bag, pts.map((p): PolyVertex => ({ p })));
    bag.set('TRACKWIDTH', formatAltiumLength(Math.max(mil(1), len(num(f[1])))));
    bag.set('REMOVEDEAD', f[9] === 'yes' ? 'FALSE' : 'TRUE');
    polygons.push(bag);
    let poured = false;
    try {
      const fill = JSON.parse(at(f, 10) || '[[]]') as unknown;
      for (const group of Array.isArray(fill) ? fill : []) for (const island of Array.isArray(group) ? group : []) {
        const rs = parsePath(String(island)).map((sp) => flattenSub(sp, 6).map(P)).filter((r) => r.length >= 3);
        if (!rs.length) continue;
        regions.push(encodeRegion({ layer, outline: rs[0]!, holes: rs.slice(1), net, polygon: index }));
        poured = true;
      }
    } catch { /* not poured */ }
    pourOrder.push({ index, order: num(f[13], index), poured });
  }

  /* ── top-level primitives, then footprints ── */
  let nComps = 0;
  for (const s of shapes) {
    const parts = String(s).split('#@$');
    const f = fields(parts[0]!);
    if (f[0] !== 'LIB') { prim(parts[0]!); continue; }
    const cpara = backtick(at(f, 3));
    const rot = norm(num(f[4]));
    const bottom = f[7] === '2';
    const subs = parts.slice(1);
    const textOf = (k: string) => subs.map(fields).find((t) => t[0] === 'TEXT' && t[1] === k);
    const des = textOf('P'), val = textOf('N');
    const ci = comps.length;
    const pos = P({ x: num(f[1]), y: num(f[2]) });
    // EasyEDA turns a bottom part after mirroring it left to right: AD's turn is 180° more
    comps.push(PropertyBag.from({
      LAYER: bottom ? 'BOTTOM' : 'TOP', PATTERN: cpara.get('package') ?? '', SOURCEDESIGNATOR: textValue(at(des ?? [], 10)), SOURCEFOOTPRINTLIBRARY: `${name}.PcbLib`,
      X: formatAltiumLength(pos.x), Y: formatAltiumLength(pos.y), ROTATION: altiumFloat(norm(bottom ? rot + 180 : rot)),
      NAMEON: des && des[12] !== 'none' ? 'TRUE' : 'FALSE', COMMENTON: val && val[12] !== 'none' ? 'TRUE' : 'FALSE', LOCKED: f[10] === '1' ? 'TRUE' : 'FALSE', COMPONENTKIND: 0,
      SOURCELIBREFERENCE: cpara.get('name') ?? cpara.get('spiceSymbolName') ?? '', SOURCEUNIQUEID: f[6] ? `\\${uniqueIdFor(`easyeda:${f[6]}`)}` : '',
      FOOTPRINTDESCRIPTION: '',
    }));
    for (const sub of subs) prim(sub, ci);
    if (!des) texts.push(encodeText({ layer: bottom ? L.BOTTOM_OVERLAY : L.TOP_OVERLAY, at: pos, height: mil(40), text: '', component: ci, isDesignator: true, mirrored: bottom }));
    if (!val) texts.push(encodeText({ layer: bottom ? L.BOTTOM_OVERLAY : L.TOP_OVERLAY, at: pos, height: mil(40), text: cpara.get('package') ?? '', component: ci, isComment: true, mirrored: bottom }));
    nComps++;
  }

  /* ── the board shape: BoardOutLine's loops, the largest the board, the rest cut-outs ── */
  // Pieces joined end to end (EasyEDA's outlines often miss by a little; a footprint's edge may bridge a gap)
  let loops: PolyVertex[][] = [];
  for (const tol of [mm(0.01), mm(0.1), mm(1.5), mm(3)]) {
    loops = nearestLoops(outlineEdges, tol).filter((l) => l.length >= 2);
    const used = loops.reduce((n, l) => n + l.length, 0);
    if (loops.length && used >= outlineEdges.length * 0.6) break;
  }
  const loopArea = (vs: PolyVertex[]) => Math.abs(vs.reduce((s, v, i) => { const q = vs[(i + 1) % vs.length]!.p; return s + v.p.x * q.y - q.x * v.p.y; }, 0));
  let outline: PolyVertex[];
  if (loops.length) {
    loops.sort((a, b) => loopArea(b) - loopArea(a));
    outline = loops[0]!;
    for (const cut of loops.slice(1)) {
      const pts = cut.flatMap((v) => [v.p]);
      if (pts.length >= 3) regions.push(encodeRegion({ layer: L.MULTI, outline: pts, boardCutout: true }));
    }
  } else {
    warnings.push('No board outline (BoardOutLine): the board shape is drawn round the contents');
    const pts = comps.map((c) => ({ x: Number.parseFloat(c.get('X') ?? '0'), y: Number.parseFloat(c.get('Y') ?? '0') }));
    void pts;
    outline = [{ p: P({ x: x0, y: y1 }) }, { p: P({ x: x0 + 400, y: y1 }) }, { p: P({ x: x0 + 400, y: y1 - 300 }) }, { p: P({ x: x0, y: y1 - 300 }) }];
  }
  const xs = outline.map((v) => v.p.x), ys = outline.map((v) => v.p.y);
  const board = newBoardRecord({ fileName: `${name}.PcbDoc`, origin: P({ x: hx, y: hy }), outline,
    sheet: { x: 0, y: 0, width: Math.max(...xs) + mil(2000), height: Math.max(...ys) + mil(2000) }, mechanical: [1, 13, 14, ...mechNames.keys()] });
  for (const [m, nm] of mechNames) board.set(`LAYER${mechLayer(m)}NAME`, nm);

  // Pour order: EasyEDA's lower fill order first
  pourOrder.sort((a, b) => a.order - b.order || a.index - b.index).forEach((o, i) => polygons[o.index]!.set('POURINDEX', String(i)));

  // The design rules' defaults (EasyEDA's units: 10 mil)
  const dr = ((doc.DRCRULE as Record<string, unknown> | undefined)?.Default ?? {}) as Record<string, unknown>;
  const mmOf = (v: unknown) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) * 0.254 : undefined);
  const { rules, classes } = boardRules({ clearance: mmOf(dr.clearance), trackWidth: mmOf(dr.trackWidth), viaDiameter: mmOf(dr.viaHoleDiameter), viaDrill: mmOf(dr.viaHoleD), classes: [] }, nets, nets);

  const pcb = assemblePcbDoc({ board, nets, comps, polygons, pads, tracks, vias, arcs, texts, regions, rules, classes }, `${name}.PcbDoc`);
  applyStackLayers(pcb, copperOrder.map((id) => ({ name: layerName.get(id) || undefined })), []);
  for (const [m, nm] of mechNames) pcb.board.layerNames.set(mechLayer(m), nm);
  const unpoured = pourOrder.filter((p) => !p.poured);
  for (const p of unpoured) repour(pcb, p.index).apply();
  if (unpoured.length) warnings.push(`${unpoured.length} copper area${unpoured.length === 1 ? '' : 's'} not poured in the file: poured with the board's rules`);
  for (const [k, n] of tally) warnings.push(`Left out: ${k} (${n})`);
  const footprints = footprintsFromBoard(pcb);
  return { bytes: writePcbDoc(pcb), name, footprints, warnings, stats: { components: nComps, pads: pads.length, vias: nVias, tracks: nTracks, nets: nets.length, layers: copperOrder.length } };
}

export function insidePoly(p: Vec2, poly: Vec2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

type Edge = { a: Vec2; b: Vec2; arc?: { c: Vec2; r: number; sa: number; ea: number } };
/** Edges joined into closed loops, each step to the nearest free end within `tol`; a chain that ends within `tol` of its start closes. */
export function nearestLoops(edges: Edge[], tol: number): PolyVertex[][] {
  const used = new Set<number>();
  const out: PolyVertex[][] = [];
  const d = (p: Vec2, q: Vec2) => Math.hypot(p.x - q.x, p.y - q.y);
  for (let i = 0; i < edges.length; i++) {
    if (used.has(i)) continue;
    used.add(i);
    const loop: PolyVertex[] = [];
    let cur = edges[i]!, from = cur.a;
    const start = from;
    for (;;) {
      const to = d(cur.a, from) <= d(cur.b, from) ? cur.b : cur.a;
      loop.push({ p: from, arc: cur.arc });
      let best = -1, bestD = tol;
      for (let k = 0; k < edges.length; k++) {
        if (used.has(k)) continue;
        const e = edges[k]!, dd = Math.min(d(e.a, to), d(e.b, to));
        if (dd <= bestD) { bestD = dd; best = k; }
      }
      if (best < 0 || (d(to, start) <= bestD && loop.length >= 2)) { if (d(to, start) <= tol && loop.length >= 2) out.push(loop); break; }
      used.add(best);
      cur = edges[best]!; from = to;
    }
  }
  return out;
}

