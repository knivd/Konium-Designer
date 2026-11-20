import type { BarcodeSpec } from '../../model/barcode';
import { FORMERS_UP } from '../../core/former';
import { readSmartUnions, readUnionNames, writeSmartUnions, writeUnionNames } from './unions';
import { cfbFind, cfbPut, cloneCfb, cfbStream, readCfb, writeCfb, type CfbEntry } from '../cfb/cfb';
import { bindWaivers, readDrcOptions, readWaivers, waiversOut } from '../../model/drcOptions';
import {
  PCB_TAG, countHeader, joinBinaryRecords, joinTextRecords, splitBinaryRecords, splitTextRecords, type PcbRawRecord,
} from './framing';
import { ARC, FILL, PAD, PAD_STACK, REGION, TEXT, TRACK, VIA, freshHeader, get, isLocked, put, setViaDiameter, type Field } from './pcbLayouts';
import { ansiToStr, bytesToBin, codePageOfStreams, currentCodePage, toCp1252Lossy, utf16le, withCodePage } from '../text';
import { PropertyBag } from './props';
import { attachPrimInfo, writePrimInfo } from './primInfo';
import { adPolygonBag, polygonName } from './polygonProps';
import { joinDimensions, readDimensions, type PcbDimension } from '../../model/dimensions';
import { connectLength, connectValue, defaultRules, joinRuleRecords, readClasses, ruleEnabled, ruleLength, ruleScope1, splitRuleRecords, type PcbRule } from './rules';
import { newBoardRules } from './newBoard';
import { BinReader, BinWriter } from '../bin';
import { formatAltiumLength, parseLength } from '../../core/units';
import { altiumFloat } from './pcbTransform';
import { arcPoints, type Vec2 } from '../../core/geom';
import { Diagnostics } from '../../model/common';
import { readRegionParts, writeRegionParts } from './regionRecord';
import { PAD_SHAPE_KEY, linkPadShapes } from '../../model/padShapes';
import { advancedIn, boardRegions, readSubstacks, regionHead, regionProps, rigidFlexFrom, type RegionRecord } from '../../model/rigidFlex';
import { L, fromV7, mechLayer, type LayerId } from '../../model/layers';
import type {
  PadShape, PadStackLayer, PcbBoard, PcbComponent, PcbDocument, PcbNet, PcbPolygon, PcbPrim, PolyVertex, PrimStream,
} from '../../model/pcb';

/** Primitive storages we decode, in draw-independent load order. */
export const PRIM_STORAGES = ['Regions6', 'ShapeBasedRegions6', 'Tracks6', 'Arcs6', 'Vias6', 'Pads6', 'Fills6', 'Texts6'] as const;

/** Storages we know about but keep verbatim for now. */
const PRESERVED = [
  'Polygons6', 'ComponentBodies6', 'ShapeBasedComponentBodies6', 'Models', 'Rules6',
  'Classes6', 'DifferentialPairs6', 'EmbeddedFonts6', 'WideStrings6', 'FileVersionInfo', 'Connections6',
];

const SHAPES: Record<number, PadShape> = { 1: 'round', 2: 'rect', 3: 'octagon', 9: 'roundrect' };

const layerOf = (v6: number | undefined, v7?: number): LayerId => {
  if (v7) { const l = fromV7(v7); if (l !== undefined) return l; }
  return v6 ?? 0;
};

/* ─── Decoders: raw record → primitive ───────────────────────────────────────────────── */

export function decodePrim(storage: string, rec: PcbRawRecord, index: number, wide: Map<number, string>): PcbPrim | null {
  const src = { storage, index };
  const s = rec.subs[0];
  if (!s) return null;
  const n = (fl: Parameters<typeof get>[1]) => get(s, fl) ?? 0;
  switch (rec.tag) {
    case PCB_TAG.TRACK: {
      if (s.length < TRACK.minLen) return null;
      const f1 = get(s, TRACK.flags1);
      return { kind: 'track', src, layer: layerOf(get(s, TRACK.layer), get(s, TRACK.layerV7)),
        a: { x: n(TRACK.x1), y: n(TRACK.y1) }, b: { x: n(TRACK.x2), y: n(TRACK.y2) }, width: n(TRACK.width),
        net: n(TRACK.net), component: n(TRACK.component), polygon: n(TRACK.polygon), locked: isLocked(f1), keepout: get(s, TRACK.flags2) === 2, ...restrictions(s, TRACK.restrict) };
    }
    case PCB_TAG.ARC: {
      if (s.length < ARC.minLen) return null;
      return { kind: 'arc', src, layer: layerOf(get(s, ARC.layer), get(s, ARC.layerV7)), c: { x: n(ARC.cx), y: n(ARC.cy) }, r: n(ARC.radius),
        start: n(ARC.start), end: n(ARC.end), width: n(ARC.width), net: n(ARC.net), component: n(ARC.component),
        polygon: n(ARC.polygon), locked: isLocked(get(s, ARC.flags1)), keepout: get(s, ARC.flags2) === 2, ...restrictions(s, ARC.restrict) };
    }
    case PCB_TAG.VIA: {
      if (s.length < VIA.minLen) return null;
      const mode = get(s, VIA.mode) ?? 0;
      const layerDiameters = mode > 0 && s.length >= VIA.layerDiameters + 32 * 4 ? Array.from({ length: 32 }, (_, k) => get(s, { off: VIA.layerDiameters + k * 4, t: 'i32' }) ?? 0) : undefined;
      return { kind: 'via', src, at: { x: n(VIA.x), y: n(VIA.y) }, diameter: n(VIA.diameter), hole: n(VIA.hole),
        layerStart: n(VIA.layerStart) || L.TOP, layerEnd: n(VIA.layerEnd) || L.BOTTOM, net: n(VIA.net), locked: isLocked(get(s, VIA.flags1)), ...(layerDiameters ? { layerDiameters } : {}),
        ...((get(s, VIA.component) ?? 0xffff) !== 0xffff ? { component: get(s, VIA.component)! } : {}),
        ...removedBits(s, VIA.removed) };
    }
    case PCB_TAG.FILL: {
      if (s.length < FILL.minLen) return null;
      return { kind: 'fill', src, layer: layerOf(get(s, FILL.layer), get(s, FILL.layerV7)), a: { x: n(FILL.x1), y: n(FILL.y1) }, b: { x: n(FILL.x2), y: n(FILL.y2) },
        rotation: n(FILL.rotation), net: n(FILL.net), component: n(FILL.component), locked: isLocked(get(s, FILL.flags1)), keepout: get(s, FILL.flags2) === 2, ...restrictions(s, FILL.restrict) };
    }
    case PCB_TAG.TEXT: {
      if (s.length < TEXT.minLen) return null;
      const ext = s.length >= TEXT.extendedLen;
      // Words still to go to WideStrings6 (a new or copied text), else its entry there
      const wideText = rec.wide ?? (ext ? wide.get(n(TEXT.wideIndex)) : undefined);
      const long = s.length >= TEXT.barcodeLen;
      // AD17's longer texts say what kind they are at 160 (a barcode keeps 0 at 43: checked on an AD17 file)
      const fontType = long ? n(TEXT.kind) : ext ? n(TEXT.fontType) : 0;
      return { kind: 'text', src, layer: layerOf(get(s, TEXT.layer), long ? get(s, TEXT.layerV7) : undefined), at: { x: n(TEXT.x), y: n(TEXT.y) }, height: n(TEXT.height),
        rotation: n(TEXT.rotation), mirrored: n(TEXT.mirrored) !== 0, strokeWidth: n(TEXT.strokeWidth),
        text: (wideText ?? decodeTextString(rec.subs[1])).replace(/\r\n/g, '\n'), component: n(TEXT.component),
        isComment: ext && n(TEXT.isComment) !== 0, isDesignator: ext && n(TEXT.isDesignator) !== 0,
        fontType, fontName: ext ? utf16le(s.subarray(TEXT.fontName, TEXT.fontName + 64)) : '',
        bold: ext && n(TEXT.bold) !== 0, italic: ext && n(TEXT.italic) !== 0, hidden: false,
        barcode: fontType === 2 && long ? barcodeOf(s) : undefined };
    }
    case PCB_TAG.REGION: return decodeRegion(storage, src, s);
    case PCB_TAG.MODEL: return storage === 'ComponentBodies6' ? decodeBody(src, s) : null;
    case PCB_TAG.PAD: {
      const p = rec.subs[4];
      if (!p || p.length < PAD.minLen) return null;
      const g = (fl: Parameters<typeof get>[1]) => get(p, fl) ?? 0;
      const stack = rec.subs[5];
      const full = stack && stack.length >= PAD_STACK.minLen ? stack : null;
      const mk = (w: number, h: number, shape: number, v6: number): PadStackLayer => {
        const alt = full?.[PAD_STACK.altShape + v6 - 1];
        const pct = full?.[PAD_STACK.cornerRadius + v6 - 1] ?? 0;
        return { w, h, shape: SHAPES[alt === 9 ? 9 : shape] ?? 'round', cornerPct: pct };
      };
      return { kind: 'pad', src, name: pascal(rec.subs[0]), layer: layerOf(g(PAD.layer), get(p, PAD.layerV7)), at: { x: g(PAD.x), y: g(PAD.y) },
        rotation: g(PAD.rotation),
        top: mk(g(PAD.topX), g(PAD.topY), g(PAD.topShape), L.TOP),
        mid: mk(g(PAD.midX), g(PAD.midY), g(PAD.midShape), L.MID1),
        bot: mk(g(PAD.botX), g(PAD.botY), g(PAD.botShape), L.BOTTOM),
        hole: g(PAD.hole), plated: g(PAD.plated) !== 0, net: g(PAD.net), component: g(PAD.component), locked: isLocked(get(p, PAD.flags1)),
        jumper: get(p, PAD.jumperId) ?? 0, stackMode: g(PAD.padMode), ...(full ? removedBits(full, PAD_STACK.removed) : {}),
        ...(full && g(PAD.padMode) === 2 ? { inner: Array.from({ length: 29 }, (_, k) => mk(get(full, { off: PAD_STACK.innerX + k * 4, t: 'i32' }) ?? 0, get(full, { off: PAD_STACK.innerY + k * 4, t: 'i32' }) ?? 0, full[PAD_STACK.innerShape + k] ?? 1, L.MID1 + k)) } : {}),
        ...(full && full[PAD_STACK.holeShape] === 2 ? { slot: { length: get(full, { off: PAD_STACK.slotLength, t: 'i32' }) ?? 0, rotation: get(full, { off: PAD_STACK.slotRotation, t: 'f64' }) ?? 0 } } : {}) };
    }
  }
  return null;
}

/** A keep-out's restriction byte, where the record is long enough to hold it. */
function restrictions(b: Uint8Array, fl: { off: number }): { keepoutRestrictions?: number } {
  return b.length > fl.off ? { keepoutRestrictions: b[fl.off]! } : {};
}

/** A byte per layer from `off` (32 of them): the layers whose unused pad shape was removed, as bits. */
function removedBits(b: Uint8Array, off: number): { removed?: number } {
  if (b.length < off + 32) return {};
  let m = 0;
  for (let k = 0; k < 32; k++) if (b[off + k] === 1) m |= 1 << k;
  return m ? { removed: m >>> 0 } : {};
}

function pascal(b: Uint8Array | undefined): string {
  if (!b || b.length === 0) return '';
  const n = b[0]!;
  return ansiToStr(bytesToBin(b.subarray(1, 1 + Math.min(n, b.length - 1))), currentCodePage());
}

/** Regions6 (f64 vertices) and ShapeBasedRegions6 (shape vertices with arcs). */
function decodeRegion(storage: string, src: { storage: string; index: number }, s: Uint8Array): PcbPrim | null {
  try {
    const r = new BinReader(s, REGION.propsAt);
    const propLen = r.u32() & 0x00ffffff; // high byte flags a binary block
    const props = PropertyBag.parse(r.bytes(propLen));
    const shapeBased = storage === 'ShapeBasedRegions6';
    let count = r.u32();
    if (shapeBased) count++; // closing vertex
    const outline: Vec2[] = [];
    for (let i = 0; i < count; i++) {
      if (shapeBased) {
        const round = r.u8() !== 0;
        const p = { x: r.i32(), y: r.i32() };
        const c = { x: r.i32(), y: r.i32() };
        const rad = r.i32();
        const a1 = r.f64(), a2 = r.f64();
        if (round && rad > 0) {
          let pts = arcPoints(c, rad, rad, a1, a2);
          const last = outline.at(-1);
          if (last && Math.hypot(pts[0]!.x - last.x, pts[0]!.y - last.y) > Math.hypot(pts.at(-1)!.x - last.x, pts.at(-1)!.y - last.y)) pts = pts.reverse();
          outline.push(...pts);
        } else outline.push(p);
      } else {
        outline.push({ x: Math.round(r.f64()), y: Math.round(r.f64()) });
      }
    }
    if (outline.length > 2) {
      const a = outline[0]!, b = outline.at(-1)!;
      if (a.x === b.x && a.y === b.y) outline.pop();
    }
    const holes: Vec2[][] = [];
    const holeCount = get(s, REGION.holeCount) ?? 0;
    for (let h = 0; h < holeCount; h++) {
      const m = r.u32();
      const hole: Vec2[] = [];
      for (let i = 0; i < m; i++) hole.push({ x: Math.round(r.f64()), y: Math.round(r.f64()) });
      holes.push(hole);
    }
    const v7 = props.get('V7_LAYER');
    const layer = (v7 ? layerFromName(v7) : undefined) ?? get(s, REGION.layer) ?? 0;
    return {
      kind: 'region', src, layer, outline, holes, regionKind: props.int('KIND'), boardCutout: props.bool('ISBOARDCUTOUT'),
      net: get(s, REGION.net) ?? 0xffff, polygon: get(s, REGION.polygon) ?? 0xffff, component: get(s, REGION.component) ?? 0xffff,
      locked: isLocked(get(s, REGION.flags1)), keepout: get(s, REGION.flags2) === 2, ...(props.has('KEEPOUTRESTRICTIONS') ? { keepoutRestrictions: props.int('KEEPOUTRESTRICTIONS') } : {}),
      ...(props.has('ARCRESOLUTION') ? { arcRes: parseLength(props.getRaw('ARCRESOLUTION')) ?? 0 } : {}),
      ...(props.has(PAD_SHAPE_KEY) ? { padShape: props.get(PAD_SHAPE_KEY) ?? '' } : {}),
      ...(props.has('KICADZONE') && !props.has('KICADTEARDROP') ? { kicadZone: { id: props.get('KICADZONE') ?? '', layers: props.get('KICADZONELAYERS') ?? '', keepout: props.get('KICADKEEPOUT') ?? '', ...(props.has('KICADZONEX') ? { x: props.getRaw('KICADZONEX') ?? '' } : {}) } } : {}),
      ...(props.has('KICADPRIM') ? { kicadPrim: { prim: props.get('KICADPRIM') ?? '', clearance: props.get('KICADCLEARANCE') ?? 'outline' } } : {}),
      ...(props.has('KICADAPERTURE') ? { kicadAperture: { id: props.get('KICADAPERTURE') ?? '', pad: props.get('KICADPAD') ?? '' } } : {}),
      ...(props.has('KICADTEARDROP') ? { kicadTeardrop: { type: props.get('KICADTEARDROP') ?? 'padvia', zone: props.get('KICADZONE') ?? '', outline: props.get('KICADOUTLINE') ?? '', priority: props.int('KICADPRIORITY') } } : {}),
    };
  } catch {
    return null;
  }
}

/** ComponentBodies6: the region-style header and property block, then the outline as f64 pairs. */
function decodeBody(src: { storage: string; index: number }, s: Uint8Array): PcbPrim | null {
  try {
    const r = new BinReader(s, REGION.propsAt);
    const props = PropertyBag.parse(r.bytes(r.u32() & 0x00ffffff));
    const n = r.u32();
    const outline: Vec2[] = [];
    for (let i = 0; i < n; i++) outline.push({ x: Math.round(r.f64()), y: Math.round(r.f64()) });
    if (outline.length > 2) { const a = outline[0]!, b = outline.at(-1)!; if (a.x === b.x && a.y === b.y) outline.pop(); }
    const v7 = props.get('V7_LAYER');
    const layer = (v7 ? layerFromName(v7) : undefined) ?? (s[0] || L.MECH1);
    const len = (k: string) => parseLength(props.getRaw(k)) ?? 0;
    return {
      kind: 'body', src, layer, outline, component: get(s, REGION.component) ?? 0xffff, locked: isLocked(get(s, REGION.flags1)),
      standoff: len('STANDOFFHEIGHT'), overall: len('OVERALLHEIGHT'), colour: props.has('BODYCOLOR3D') ? props.int('BODYCOLOR3D') : 0x808080,
      opacity: props.has('BODYOPACITY3D') ? props.float('BODYOPACITY3D') : 1, bottom: props.int('BODYPROJECTION') === 1,
      modelType: props.int('MODEL.MODELTYPE'), identifier: bodyIdentifier(props.get('IDENTIFIER') ?? ''), modelName: props.get('MODEL.NAME') ?? '',
    };
  } catch {
    return null;
  }
}

/** A 3D body's IDENTIFIER is kept as comma-separated character codes ("70,105,100" = "Fid"). */
export const bodyIdentifier = (v: string): string => (/^\d+(,\d+)*$/.test(v.trim()) ? String.fromCharCode(...v.split(',').map(Number)) : v);
export const bodyIdentifierValue = (s: string): string => [...s].map((c) => c.charCodeAt(0)).join(',');

/** Altium layer names as used in V7_LAYER properties (TOP, MID3, MECHANICAL17 …). */
export function layerFromName(name: string): LayerId | undefined {
  const n = name.trim().toUpperCase();
  const fixed: Record<string, LayerId> = {
    TOP: L.TOP, BOTTOM: L.BOTTOM, TOPOVERLAY: L.TOP_OVERLAY, BOTTOMOVERLAY: L.BOTTOM_OVERLAY, TOPPASTE: L.TOP_PASTE,
    BOTTOMPASTE: L.BOTTOM_PASTE, TOPSOLDER: L.TOP_SOLDER, BOTTOMSOLDER: L.BOTTOM_SOLDER, DRILLGUIDE: L.DRILL_GUIDE,
    KEEPOUT: L.KEEPOUT, DRILLDRAWING: L.DRILL_DRAWING, MULTILAYER: L.MULTI,
  };
  if (fixed[n] !== undefined) return fixed[n];
  let m = /^MID(\d+)$/.exec(n);
  if (m) return 1 + Number(m[1]);
  m = /^PLANE(\d+)$/.exec(n);
  if (m) return L.PLANE1 + Number(m[1]) - 1;
  m = /^MECHANICAL(\d+)$/.exec(n);
  if (m) return mechLayer(Number(m[1]));
  return undefined;
}

function decodeTextString(b: Uint8Array | undefined): string {
  if (!b || b.length === 0) return '';
  if (b[0] === b.length - 1) return pascal(b);
  let end = b.length;
  while (end > 0 && b[end - 1] === 0) end--;
  return ansiToStr(bytesToBin(b.subarray(0, end)), currentCodePage());
}

/* ─── Board, nets, components ────────────────────────────────────────────────────────── */

function textRecords(root: CfbEntry, storage: string): PropertyBag[] {
  const d = cfbStream(root, `${storage}/Data`);
  return d ? splitTextRecords(d) : [];
}

/**
 * Konium Designer's own Board6 keys (grids, guides, the sheet, the route tool layer, the axis snap
 * range) as boards saved under the app's earlier names keep them: taken over under the present name
 * (the most recent name's where both are there).
 */
export function adoptFormerKeys(bag: PropertyBag): void {
  for (const f of FORMERS_UP) {
    for (const k of bag.keys()) {
      if (!k.toUpperCase().startsWith(f)) continue;
      const now = `KONIUM${k.slice(f.length)}`, v = bag.get(k);
      if (!bag.has(now) && v !== undefined) bag.set(now, v);
      bag.delete(k);
    }
  }
}

function decodeBoard(bag: PropertyBag | undefined, diags: Diagnostics): PcbBoard {
  const board: PcbBoard = { bag, origin: { x: 0, y: 0 }, outline: [], vertices: [], copperStack: [L.TOP, L.BOTTOM], layerNames: new Map() };
  if (!bag) { diags.warn('Board6 missing — no outline or stack'); return board; }
  adoptFormerKeys(bag);
  const len = (k: string) => parseLength(bag.getRaw(k)) ?? 0;
  board.origin = { x: len('ORIGINX'), y: len('ORIGINY') };

  // Outline: VXi/VYi vertices; KINDi ≠ 0 means segment i is an arc (CXi, CYi, Ri, SAi, EAi)
  let verts = readVertices(bag);
  // The last vertex repeats the first to close the shape
  if (verts.length > 2) { const a = verts[0]!.p, b = verts.at(-1)!.p; if (a.x === b.x && a.y === b.y && !verts.at(-1)!.arc) verts = verts.slice(0, -1); }
  board.vertices = verts;
  board.outline = flattenVertices(verts);

  // Layer names and copper stack via LAYERnNEXT links
  for (let n = 1; n <= 82; n++) {
    const nm = bag.get(`LAYER${n}NAME`);
    if (nm) board.layerNames.set(n, nm);
  }
  // V7 stack: LAYERV7_iNAME + LAYERV7_iLAYERID (32-bit id) — carries names for mech layers > 16 too
  for (let i = 0; bag.has(`LAYERV7_${i}NAME`); i++) {
    const id = fromV7(bag.int(`LAYERV7_${i}LAYERID`));
    const nm = bag.get(`LAYERV7_${i}NAME`);
    if (id !== undefined && nm) board.layerNames.set(id, nm);
  }
  if (bag.has('LAYER1NEXT')) {
    const stack: LayerId[] = [L.TOP];
    const seen = new Set<number>([L.TOP]);
    let cur: number = L.TOP;
    for (let guard = 0; guard < 64; guard++) {
      const nxt = bag.int(`LAYER${cur}NEXT`);
      if (!nxt || seen.has(nxt) || nxt > L.PLANE16) break;
      stack.push(nxt);
      seen.add(nxt);
      if (nxt === L.BOTTOM) break;
      cur = nxt;
    }
    if (stack.at(-1) === L.BOTTOM) board.copperStack = stack;
  }
  return board;
}

/* ─── Outlines and polygons ──────────────────────────────────────────────────────────── */

/** Outline vertices with arc edges flattened (Board6 shape, Polygons6). */
export function flattenVertices(verts: PolyVertex[]): Vec2[] {
  const out: Vec2[] = [];
  for (const v of verts) {
    out.push(v.p);
    if (v.arc) {
      let pts = arcPoints(v.arc.c, v.arc.r, v.arc.r, v.arc.sa, v.arc.ea);
      const near = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y) < v.arc!.r * 0.05 + 100;
      if (!near(pts[0]!, v.p)) pts = pts.reverse();
      out.push(...pts.slice(1, -1));
    }
  }
  return out;
}

export function readVertices(bag: PropertyBag): PolyVertex[] {
  const len = (k: string) => parseLength(bag.getRaw(k)) ?? 0;
  const verts: PolyVertex[] = [];
  for (let i = 0; bag.has(`VX${i}`); i++) {
    const v: PolyVertex = { p: { x: len(`VX${i}`), y: len(`VY${i}`) } };
    if (bag.int(`KIND${i}`) !== 0) v.arc = { c: { x: len(`CX${i}`), y: len(`CY${i}`) }, r: len(`R${i}`), sa: bag.float(`SA${i}`), ea: bag.float(`EA${i}`) };
    verts.push(v);
  }
  return verts;
}

/** Write vertices as Altium does: KINDn, VXn, VYn, CXn, CYn, SAn, EAn, Rn, then the closing copy of vertex 0. */
export function writeVertices(bag: PropertyBag, verts: PolyVertex[]): void {
  const all = [...verts, verts[0]!];
  const entries: [string, string][] = [];
  all.forEach((v, i) => {
    entries.push([`KIND${i}`, v.arc ? '1' : '0'], [`VX${i}`, formatAltiumLength(v.p.x)], [`VY${i}`, formatAltiumLength(v.p.y)],
      [`CX${i}`, formatAltiumLength(v.arc?.c.x ?? 0)], [`CY${i}`, formatAltiumLength(v.arc?.c.y ?? 0)],
      [`SA${i}`, altiumFloat(v.arc?.sa ?? 0)], [`EA${i}`, altiumFloat(v.arc?.ea ?? 0)], [`R${i}`, formatAltiumLength(v.arc?.r ?? 0)]);
  });
  // In place of the old vertices, as Altium keeps them in the middle of Board6
  bag.replaceGroup((k) => /^(KIND|VX|VY|CX|CY|SA|EA|R)\d+$/i.test(k), entries);
}

export function polygonFromBag(bag: PropertyBag, index: number): PcbPolygon {
  let vertices = readVertices(bag);
  // The last vertex repeats the first to close the shape
  if (vertices.length > 2) { const a = vertices[0]!.p, b = vertices.at(-1)!.p; if (a.x === b.x && a.y === b.y && !vertices.at(-1)!.arc) vertices = vertices.slice(0, -1); }
  return {
    index, bag, name: polygonName(bag), layer: layerFromName(bag.get('LAYER') ?? 'TOP') ?? L.TOP,
    net: bag.int('NET', NO_NET_ID), vertices, outline: flattenVertices(vertices), hatch: bag.get('HATCHSTYLE') ?? 'Solid',
    type: bag.get('POLYGONTYPE') ?? 'Polygon',
  };
}
const NO_NET_ID = 0xffff;

/* ─── Document ───────────────────────────────────────────────────────────────────────── */

export function componentFromBag(bag: PropertyBag, index: number): PcbComponent {
  return {
    index, bag,
    designator: bag.get('SOURCEDESIGNATOR') ?? '',
    pattern: bag.get('PATTERN') ?? '',
    at: { x: parseLength(bag.getRaw('X')) ?? 0, y: parseLength(bag.getRaw('Y')) ?? 0 },
    rotation: bag.float('ROTATION'),
    layer: (bag.get('LAYER') ?? 'TOP').toUpperCase() === 'BOTTOM' ? L.BOTTOM : L.TOP,
    nameOn: bag.has('NAMEON') ? bag.bool('NAMEON') : true,
    commentOn: bag.bool('COMMENTON'),
  };
}

/** WideStrings6/Data (PcbDoc) and <footprint>/WideStrings (PcbLib): u32 index, u32 byte length, UTF-16LE. */
export function parseWideStrings(ws: Uint8Array | undefined): Map<number, string> {
  const wide = new Map<number, string>();
  if (!ws) return wide;
  const dv = new DataView(ws.buffer, ws.byteOffset, ws.byteLength);
  for (let o = 0; o + 8 <= ws.length;) {
    const idx = dv.getUint32(o, true);
    let n = dv.getUint32(o + 4, true);
    o += 8;
    if (n <= 2) n = 0; // lengths ≤ 2 carry no bytes at all
    if (o + n > ws.length) break;
    wide.set(idx, utf16le(ws.subarray(o, o + n)));
    o += n;
  }
  return wide;
}

export function readPcbDoc(bytes: Uint8Array, name: string): PcbDocument {
  const cfb = readCfb(bytes);
  // Text without a %UTF8% twin is in the code page of the author's Windows (told from the property records)
  const cp = codePageOfStreams(...['Board6', 'Components6', 'Nets6', 'Classes6', 'Rules6', 'Dimensions6', 'Polygons6', 'Rooms6'].map((s) => cfbStream(cfb.root, `${s}/Data`)));
  const doc = withCodePage(cp, () => readPcbDocIn(cfb, name));
  if (cp !== 1252) doc.diags.info(`text in Windows code page ${cp}`);
  return doc;
}
function readPcbDocIn(cfb: ReturnType<typeof readCfb>, name: string): PcbDocument {
  const diags = new Diagnostics();
  const root = cfb.root;
  if (!cfbFind(root, 'Board6')) diags.warn('no Board6 storage — is this a PcbDoc?');

  const board = decodeBoard(textRecords(root, 'Board6')[0], diags);
  const nets: PcbNet[] = textRecords(root, 'Nets6').map((bag, index) => ({ index, name: bag.get('NAME') ?? `Net${index}`, bag }));
  const components: PcbComponent[] = textRecords(root, 'Components6').map(componentFromBag);

  const streams = new Map<string, PrimStream>();
  for (const storage of PRIM_STORAGES) {
    const data = cfbStream(root, `${storage}/Data`);
    if (!data) continue;
    try {
      streams.set(storage, { storage, records: splitBinaryRecords(data) });
    } catch (e) {
      diags.error(`${storage}: ${(e as Error).message} — storage kept verbatim, not drawn`);
    }
  }

  const rulesData = cfbStream(root, 'Rules6/Data');
  let rules = [] as ReturnType<typeof splitRuleRecords>;
  try { rules = rulesData ? splitRuleRecords(rulesData) : []; } catch (e) { diags.warn(`Rules6: ${(e as Error).message} — default rules used`); }
  const rulesInFile = rules.length > 0;
  if (!rulesInFile) rules = defaultRules();
  const classes = readClasses(textRecords(root, 'Classes6'));
  const polygons = textRecords(root, 'Polygons6').map(polygonFromBag);
  // Component bodies (3D models) reference components by index: kept as records so deleting a part can renumber them
  const bodies = cfbStream(root, 'ComponentBodies6/Data');
  if (bodies) { try { streams.set('ComponentBodies6', { storage: 'ComponentBodies6', records: splitBinaryRecords(bodies) }); } catch { /* kept verbatim */ } }
  let dimensions: PcbDimension[] = [];
  try { dimensions = readDimensions(cfbStream(root, 'Dimensions6/Data')); } catch (e) { diags.warn(`Dimensions6: ${(e as Error).message} — kept verbatim, not drawn`); }
  // Mask expansions and pad unique IDs, tied to their primitives (they're kept by index in the file)
  const side = attachPrimInfo(root, (s) => streams.get(s)?.records);
  const diffPairs = textRecords(root, 'DifferentialPairs6');
  const unionNames = readUnionNames(root), smartUnions = readSmartUnions(root);
  // Rigid-flex: the board's regions (one on a rigid board), their stacks and bending lines
  let regionRecs: RegionRecord[] = [];
  const regionData = cfbStream(root, 'BoardRegions/Data');
  if (regionData) {
    try {
      regionRecs = splitBinaryRecords(regionData).filter((r) => r.subs[0]).map((r) => {
        const p = readRegionParts('Regions6', r.subs[0]!);
        return { props: p.props, outline: p.verts.map((v) => ({ x: v.x, y: v.y })), head: p.head };
      });
    } catch (e) { diags.warn(`BoardRegions: ${(e as Error).message} — kept verbatim`); }
  }
  const flex = rigidFlexFrom(board.outline, regionRecs, readSubstacks(board.bag)[0]?.id ?? '', advancedIn(board.bag));
  if (flex.fixed) diags.info(`${regionRecs.length} board regions kept as the file has them (their split lines couldn't be worked out)`);
  const regionTwins = pairRegionTwins(streams);
  const drcOptions = readDrcOptions(cfbStream(root, 'Design Rule Checker Options6/Data'));
  const waivers = readWaivers(cfbStream(root, 'WaivedViolations/Data'));
  const doc: PcbDocument = { kind: 'PcbDoc', name, cfb, board, nets, components, prims: [], streams, dirty: new Set(), diags, rules, rulesInFile, classes, polygons, dimensions, side, diffPairs, unionNames, smartUnions, flex, drcOptions, waivers, regionTwins };
  rebuildPrims(doc);
  bindWaivers(doc);

  const counts = PRIM_STORAGES.map((s) => `${s.replace('6', '')} ${streams.get(s)?.records.length ?? 0}`).join(', ');
  diags.info(`${nets.length} nets, ${components.length} components; ${counts}`);
  // Records that could not be read (too short for their kind, a region that doesn't parse), by stream. Not among them: a
  // region's second copy in ShapeBasedRegions6, which is read once, from Regions6 (they were counted, so every board
  // saved by the desktop software with a region said one of its records was short)
  const twins = new Set(regionTwins.values()).size;
  const unread = PRIM_STORAGES.map((s) => {
    const n = (streams.get(s)?.records.length ?? 0) - (s === 'ShapeBasedRegions6' ? twins : 0) - doc.prims.filter((p) => p.src.storage === s).length;
    return n > 0 ? `${s.replace('6', '')} ${n}` : '';
  }).filter(Boolean);
  if (unread.length) diags.warn(`${unread.join(', ')}: records that could not be read, kept in the file as they are and not drawn`);
  for (const s of PRESERVED) {
    const hdr = cfbStream(root, `${s}/Header`);
    const cnt = hdr && hdr.length >= 4 ? new DataView(hdr.buffer, hdr.byteOffset).getUint32(0, true) : 0;
    if (cnt > 0) diags.info(`${s}: ${cnt} records preserved, not yet modelled`);
  }
  return doc;
}

/** Re-derive typed primitives from raw records. Call after any record change. */
export function rebuildPrims(doc: PcbDocument): void {
  const wide = parseWideStrings(cfbStream(doc.cfb.root, 'WideStrings6/Data'));
  const prims: PcbPrim[] = [];
  const twins = doc.regionTwins?.size ? new Set(doc.regionTwins.values()) : null;
  for (const [storage, s] of doc.streams) {
    s.records.forEach((rec, i) => {
      if (twins && storage === 'ShapeBasedRegions6' && twins.has(rec)) return;
      const p = decodePrim(storage, rec, i, wide); if (p) prims.push(p);
    });
  }
  // Component-owned designator/comment texts follow the component's NAMEON / COMMENTON
  for (const p of prims) {
    if (p.kind !== 'text') continue;
    const comp = doc.components[p.component];
    if (!comp) continue;
    if (p.isDesignator || /^\.designator$/i.test(p.text)) { p.text = comp.designator; p.hidden = !comp.nameOn; }
    else if (p.isComment) p.hidden = !comp.commentOn;
  }
  // Polygon pads: their shapes' regions linked to them, on their nets
  linkPadShapes(prims);
  doc.prims = prims;
}

/** A pad's or via's connection to internal planes (PAD.relief, VIA.relief). */
export interface PlaneRelief { /** 0 no connect, 1 relief, 2 direct */ style: number; gap: number; entries: number; width: number; expansion: number; clearance: number }
/** AD's default Power Plane Connect (relief, 10 mil air gap, 4 entries 10 mil wide, 20 mil expansion) and Plane Clearance (20 mil). */
export const AD_PLANE_RELIEF: PlaneRelief = { style: 1, gap: 100_000, entries: 4, width: 100_000, expansion: 200_000, clearance: 200_000 };

/** The plane connection the board's rules for everything give a pad or via, AD's defaults where it has none. */
export function planeReliefOf(rules: PcbRule[], kind: 'pad' | 'via'): PlaneRelief {
  const all = (k: string) => rules.find((r) => ruleEnabled(r) && r.bag.get('RULEKIND') === k && ruleScope1(r).trim() === 'All');
  const pc = all('PlaneConnect'), cl = all('PlaneClearance'), d = AD_PLANE_RELIEF, prim = { kind };
  const entries = pc ? Number(connectValue(pc, 'RELIEFENTRIES', prim)) : NaN;
  const style = (pc ? String(connectValue(pc, 'PLANECONNECTSTYLE', prim) ?? 'Relief') : 'Relief').toLowerCase();
  return {
    style: style.startsWith('direct') ? 2 : style.startsWith('no') ? 0 : 1,
    gap: pc ? connectLength(pc, 'RELIEFAIRGAP', '10mil', prim) : d.gap,
    entries: entries === 2 || entries === 4 ? entries : d.entries,
    width: pc ? connectLength(pc, 'RELIEFCONDUCTORWIDTH', '10mil', prim) : d.width,
    expansion: pc ? connectLength(pc, 'RELIEFEXPANSION', '20mil', prim) : d.expansion,
    clearance: cl ? ruleLength(cl, 'CLEARANCE', '20mil') : d.clearance,
  };
}

/**
 * A pad or via record given a plane connection when it has none (no relief entries), as AD's own
 * records always carry one; `style` too (a via, a pad with a hole). True when the record changed.
 */
export function putPlaneRelief(s: Uint8Array, at: typeof VIA.relief | typeof PAD.relief, v: PlaneRelief, style = false): boolean {
  if (s.length < at.clearance.off + 4 || get(s, at.entries) !== 0) return false;
  put(s, at.gap, v.gap); put(s, at.entries, v.entries); put(s, at.width, v.width); put(s, at.expansion, v.expansion); put(s, at.clearance, v.clearance);
  if (style) put(s, at.style, v.style);
  return true;
}

/**
 * Internal planes' nets as AD keeps them: a Split Plane over the board on the plane layer, with the
 * net (AD's own boards always have one for a plane with a net; AD takes a plane's net from its split
 * planes and loads a plane named only in PLANEnNETNAME with no net [checked: AD17 saved such boards
 * with (No Net) and joined nothing through their planes]). A plane with a net and no split plane, from
 * an earlier Konium or another tool's file, gets one on saving: the board's shape, turned the way AD
 * turns it.
 */
function planeSplitsOut(doc: PcbDocument): void {
  const v = doc.board.vertices, n = v.length;
  if (n < 3) return;
  for (const layer of doc.board.copperStack) {
    if (layer < L.PLANE1 || layer > L.PLANE16) continue;
    const name = doc.board.bag?.get(`PLANE${layer - L.PLANE1 + 1}NETNAME`);
    const net = name ? doc.nets.findIndex((x) => x.name === name) : -1;
    if (net < 0 || doc.polygons.some((p) => p.layer === layer && /split/i.test(p.type))) continue;
    const bag = PropertyBag.from({
      SELECTION: 'FALSE', LAYER: layerToName(layer), LOCKED: 'FALSE', POLYGONOUTLINE: 'FALSE', USERROUTED: 'TRUE', KEEPOUT: 'FALSE', UNIONINDEX: '0',
      PRIMITIVELOCK: 'TRUE', POLYGONTYPE: 'Split Plane',
    });
    // The other way round (each arc moves to the vertex its edge now starts from), from a corner
    // that starts a straight edge (the closing copy of the first vertex carries its arc too)
    const back: PolyVertex[] = v.map((_, k) => ({ p: v[n - 1 - k]!.p, ...(v[(2 * n - 2 - k) % n]!.arc ? { arc: v[(2 * n - 2 - k) % n]!.arc } : {}) }));
    const from = Math.max(0, back.findIndex((x) => !x.arc));
    writeVertices(bag, [...back.slice(from), ...back.slice(0, from)]);
    bag.set('NET', String(net));
    doc.polygons.push(polygonFromBag(bag, doc.polygons.length));
    doc.dirty.add('Polygons6');
    planeEdges(doc, layer);
  }
}

/** A plane layer's pullback: its stack entry's, else Board6's PLANEnPULLBACK, else AD's 20 mil. */
function planePullback(doc: PcbDocument, layer: LayerId): number {
  const b = doc.board.bag;
  if (!b) return 200_000;
  const v7 = String(toV7(layer));
  for (let i = 1; b.has(`V9_STACK_LAYER${i}_LAYERID`); i++) {
    if (b.get(`V9_STACK_LAYER${i}_LAYERID`) === v7) { const d = parseLength(b.get(`V9_STACK_LAYER${i}_PULLBACKDISTANCE`)); if (d !== undefined) return d; }
  }
  return parseLength(b.get(`PLANE${layer - L.PLANE1 + 1}PULLBACK`)) ?? 200_000;
}

/**
 * The board's edge on a plane layer as AD draws it there: tracks (and arcs) along the board shape,
 * twice the pullback wide (0.1 mil with none), on no net, of AD's "board" (polygon 0xFFFE), as every
 * AD board with a split plane has them; added when the layer has none.
 */
function planeEdges(doc: PcbDocument, layer: LayerId): void {
  if (doc.prims.some((p) => 'layer' in p && p.layer === layer && 'polygon' in p && p.polygon === 0xfffe)) return;
  const v = doc.board.vertices, width = Math.max(1000, 2 * planePullback(doc, layer));
  const ofBoard = (s: Uint8Array, at: typeof TRACK | typeof ARC) => { put(s, at.flags1, 0x0c); put(s, at.flags2, 0); put(s, at.polygon, 0xfffe); put(s, at.subpoly, 0); return s; };
  const st = (name: string) => { let s = doc.streams.get(name); if (!s) { s = { storage: name, records: [] }; doc.streams.set(name, s); } return s; };
  const tracks = st('Tracks6'), arcs = st('Arcs6');
  v.forEach((x, k) => {
    const b = v[(k + 1) % v.length]!.p;
    if (x.arc) {
      const r = encodeArc({ layer, c: x.arc.c, r: x.arc.r, start: x.arc.sa, end: x.arc.ea, width }, arcs.records[0]);
      ofBoard(r.subs[0]!, ARC);
      arcs.records.push(r);
      doc.dirty.add('Arcs6');
    } else {
      const r = encodeTrack({ layer, a: x.p, b, width }, tracks.records[0]);
      ofBoard(r.subs[0]!, TRACK);
      tracks.records.push(r);
      doc.dirty.add('Tracks6');
    }
  });
  rebuildPrims(doc);
}

/**
 * Planes as AD needs them to join: a board with a plane that has a net and no Power Plane Connect rule
 * gets AD's default one (AD adds its own on opening but leaves it unapplied until an edit has it apply
 * the rules, and joins nothing through planes meanwhile [checked: AD17, the same board with the rule
 * written in: 0 violations on opening]); every via and pad with a hole its connect style where it has
 * none, as AD's own records keep it (0 none, 1 relief, 2 direct: AD wrote 1 once it had applied the
 * rules); and pads and vias an earlier Konium wrote without a plane connection the one the rules give.
 * AD's own boards already have all of it, so only a rule that keeps pads and vias off planes (No
 * Connect) leaves their style as it is.
 */
function planeReliefs(doc: PcbDocument): void {
  const planes = doc.board.copperStack.filter((l) => l >= L.PLANE1 && l <= L.PLANE16);
  const netted = planes.some((l) => {
    const name = doc.board.bag?.get(`PLANE${l - L.PLANE1 + 1}NETNAME`);
    return (!!name && doc.nets.some((n) => n.name === name)) || doc.polygons.some((p) => p.layer === l && /split/i.test(p.type) && p.net !== 0xffff);
  });
  const noConnect = doc.rules.some((r) => ruleEnabled(r) && r.bag.get('RULEKIND') === 'PlaneConnect' && /^no/i.test(r.bag.get('PLANECONNECTSTYLE') ?? ''));
  // A board with a netted plane and no Power Plane Connect rule gets AD's default one: AD adds its own
  // on opening, but doesn't apply it until something has it apply the rules, and joins nothing to a
  // plane meanwhile [checked: AD17's starved thermals on such a board went once an edit had it apply them]
  if (netted && !doc.rules.some((r) => r.bag.get('RULEKIND') === 'PlaneConnect')) {
    const rule = newBoardRules().find((r) => r.bag.get('RULEKIND') === 'PlaneConnect');
    if (rule) { doc.rules.push(rule); doc.dirty.add('Rules6'); }
  }
  for (const [storage, sub, at, kind] of [['Vias6', 0, VIA.relief, 'via'], ['Pads6', 4, PAD.relief, 'pad']] as const) {
    const recs = doc.streams.get(storage)?.records;
    if (!recs) continue;
    let v: PlaneRelief | undefined;
    recs.forEach((rec, i) => {
      const s = rec.subs[sub];
      if (!s || s.length < at.clearance.off + 4) return;
      const holed = kind === 'via' || (s.length >= PAD.hole.off + 4 && (get(s, PAD.hole) ?? 0) > 0);
      const fill = get(s, at.entries) === 0;
      const styled = holed && netted && !noConnect && get(s, at.style) === 0;
      if (!fill && !styled) return;
      const out = s.slice();
      v ??= planeReliefOf(doc.rules, kind);
      if (fill) putPlaneRelief(out, at, v, holed);
      if (styled) put(out, at.style, v.style);
      recs[i] = { tag: rec.tag, subs: rec.subs.map((x, k) => (k === sub ? out : x)) };
      doc.dirty.add(storage);
    });
  }
}

/**
 * Polygon pads' regions as saved: each one's net and KONIUMPADSHAPE its pad's now (Konium
 * Designer links them by place, so a pad renamed or re-netted keeps its shape; AD reads the net).
 */
function syncPadShapes(doc: PcbDocument): void {
  for (const r of doc.prims) {
    if (r.kind !== 'region' || !r.shapeOf) continue;
    const pad = doc.prims.find((p) => p.kind === 'pad' && `${p.src.storage}:${p.src.index}` === r.shapeOf) as Extract<PcbPrim, { kind: 'pad' }> | undefined;
    const rec = doc.streams.get(r.src.storage)?.records[r.src.index];
    const s = rec?.subs[0];
    if (!pad || !rec || !s) continue;
    const parts = readRegionParts(r.src.storage, s);
    const named = parts.props.get(PAD_SHAPE_KEY) === pad.name;
    const netted = get(s, REGION.net) === pad.net;
    if (named && netted) continue;
    if (!named) parts.props.set(PAD_SHAPE_KEY, pad.name);
    const out = writeRegionParts(parts);
    put(out, REGION.net, pad.net);
    doc.streams.get(r.src.storage)!.records[r.src.index] = { tag: rec.tag, subs: [out, ...rec.subs.slice(1)] };
    doc.dirty.add(r.src.storage);
  }
}

export function writePcbDoc(doc: PcbDocument): Uint8Array {
  syncPadShapes(doc);
  planeReliefs(doc);
  planeSplitsOut(doc);
  const root = cloneCfb(doc.cfb.root);
  if (doc.dirty.has('Rules6')) {
    cfbPut(root, 'Rules6/Data', joinRuleRecords(doc.rules));
    cfbPut(root, 'Rules6/Header', countHeader(doc.rules.length));
  }
  // Text storages the ECO edits: one property record per component / net, in index order
  if (doc.dirty.has('Components6')) {
    cfbPut(root, 'Components6/Data', joinTextRecords(doc.components.map((c) => c.bag)));
    cfbPut(root, 'Components6/Header', countHeader(doc.components.length));
  }
  if (doc.dirty.has('Polygons6')) {
    // (pours from boards an earlier Konium wrote go out in AD's form)
    cfbPut(root, 'Polygons6/Data', joinTextRecords(doc.polygons.map((p) => adPolygonBag(p.bag))));
    cfbPut(root, 'Polygons6/Header', countHeader(doc.polygons.length));
  }
  if (doc.dirty.has('Board6') && doc.board.bag) cfbPut(root, 'Board6/Data', joinTextRecords([doc.board.bag]));
  if (doc.dirty.has('Dimensions6')) {
    cfbPut(root, 'Dimensions6/Data', joinDimensions(doc.dimensions));
    cfbPut(root, 'Dimensions6/Header', countHeader(doc.dimensions.length));
  }
  if (doc.dirty.has('DifferentialPairs6')) {
    cfbPut(root, 'DifferentialPairs6/Data', joinTextRecords(doc.diffPairs ?? []));
    cfbPut(root, 'DifferentialPairs6/Header', countHeader(doc.diffPairs?.length ?? 0));
  }
  if (doc.dirty.has('UnionNames')) writeUnionNames(root, doc.unionNames ?? []);
  if (doc.dirty.has('Design Rule Checker Options6') && doc.drcOptions) {
    cfbPut(root, 'Design Rule Checker Options6/Data', joinTextRecords([doc.drcOptions]));
    if (!cfbStream(root, 'Design Rule Checker Options6/Header')) cfbPut(root, 'Design Rule Checker Options6/Header', countHeader(1));
  }
  if (doc.dirty.has('SmartUnions')) writeSmartUnions(root, doc.smartUnions ?? []);
  if (doc.dirty.has('Classes6')) {
    cfbPut(root, 'Classes6/Data', joinTextRecords(doc.classes.map((c) => c.bag)));
    cfbPut(root, 'Classes6/Header', countHeader(doc.classes.length));
  }
  if (doc.dirty.has('Nets6')) {
    cfbPut(root, 'Nets6/Data', joinTextRecords(doc.nets.map((n) => n.bag)));
    cfbPut(root, 'Nets6/Header', countHeader(doc.nets.length));
  }
  // Waived violations follow their rules and objects to where they now are
  const waived = waiversOut(doc);
  if (waived) {
    cfbPut(root, 'WaivedViolations/Data', joinTextRecords(waived));
    cfbPut(root, 'WaivedViolations/Header', countHeader(waived.length));
  }
  const shapes = twinRegionsOut(doc);
  for (const storage of new Set([...doc.dirty, ...(shapes ? ['ShapeBasedRegions6'] : [])])) {
    const s = doc.streams.get(storage);
    if (!s) continue;
    // Texts Konium added get their WideStrings6 entry, as every AD17 text has one
    const records = storage === 'Texts6' ? withWideStrings(root, s.records) : storage === 'ShapeBasedRegions6' && shapes ? shapes : s.records;
    cfbPut(root, `${storage}/Data`, joinBinaryRecords(records));
    cfbPut(root, `${storage}/Header`, countHeader(records.length));
  }
  // The board's regions follow its shape, split lines and stacks (AD17 boards always have them)
  if (doc.dirty.has('BoardRegions') || (doc.dirty.has('Board6') && !cfbFind(root, 'BoardRegions'))) {
    const recs = boardRegions(doc).map((r) => ({ tag: 11, subs: [writeRegionParts({
      shapeBased: false, head: regionHead(r), props: regionProps(r), propHigh: 0, verts: r.outline.map((v) => ({ x: v.x, y: v.y })), holes: [], tail: new Uint8Array(0),
    })] }));
    cfbPut(root, 'BoardRegions/Data', joinBinaryRecords(recs));
    cfbPut(root, 'BoardRegions/Header', countHeader(recs.length));
  }
  writePrimInfo(root, doc.streams, doc.dirty, doc.side);
  return writeCfb(root);
}

/* ─── Region twins (Regions6 / ShapeBasedRegions6) ────────────────────────────────────── */

/** A region's identity for pairing: layer, owners, kind and its outline's box to 1 mil. */
function regionKey(storage: string, rec: PcbRawRecord): string | null {
  const p = decodePrim(storage, rec, 0, new Map());
  if (!p || p.kind !== 'region' || !p.outline.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const v of p.outline) { x0 = Math.min(x0, v.x); y0 = Math.min(y0, v.y); x1 = Math.max(x1, v.x); y1 = Math.max(y1, v.y); }
  const m = (v: number) => Math.round(v / 10000);
  return `${p.layer}/${p.net}/${p.polygon}/${p.component}/${p.regionKind}/${p.holes.length}/${m(x0)},${m(y0)},${m(x1)},${m(y1)}`;
}

/** Each Regions6 record's twin in ShapeBasedRegions6 (AD writes every region to both). */
export function pairRegionTwins(streams: Map<string, PrimStream>): Map<PcbRawRecord, PcbRawRecord> {
  const pairs = new Map<PcbRawRecord, PcbRawRecord>();
  const a = streams.get('Regions6')?.records ?? [], b = streams.get('ShapeBasedRegions6')?.records ?? [];
  if (!a.length || !b.length) return pairs;
  // As AD saves them: the same regions in the same order (a shape-based one's arcs make its
  // outline differ, so they pair by place when their owners and layers agree)
  if (a.length === b.length) {
    const owners = (storage: string, r: PcbRawRecord) => { const p = decodePrim(storage, r, 0, new Map()); return p && p.kind === 'region' ? `${p.layer}/${p.net}/${p.polygon}/${p.component}/${p.regionKind}/${p.holes.length}` : null; };
    if (a.every((r, i) => { const k = owners('Regions6', r); return k !== null && k === owners('ShapeBasedRegions6', b[i]!); })) {
      a.forEach((r, i) => pairs.set(r, b[i]!));
      return pairs;
    }
  }
  const free = new Map<string, PcbRawRecord[]>();
  for (const r of b) { const k = regionKey('ShapeBasedRegions6', r); if (k) (free.get(k) ?? free.set(k, []).get(k)!).push(r); }
  for (const r of a) { const k = regionKey('Regions6', r); const t = k ? free.get(k)?.shift() : undefined; if (t) pairs.set(r, t); }
  return pairs;
}

/**
 * ShapeBasedRegions6 as saved when the board keeps twins and its regions changed: each Regions6
 * region's twin as read while it is unchanged, else one made from it (straight edges), then the
 * shape-based regions that have no twin.
 */
function twinRegionsOut(doc: PcbDocument): PcbRawRecord[] | null {
  const twins = doc.regionTwins;
  if (!twins?.size || !(doc.dirty.has('Regions6') || doc.dirty.has('ShapeBasedRegions6'))) return null;
  const own = doc.streams.get('Regions6')?.records ?? [];
  const taken = new Set(twins.values());
  const lone = (doc.streams.get('ShapeBasedRegions6')?.records ?? []).filter((r) => !taken.has(r));
  return [...own.map((r) => twins.get(r) ?? shapeBasedTwin(r)), ...lone];
}

export function shapeBasedTwin(rec: PcbRawRecord): PcbRawRecord {
  const s = rec.subs[0];
  if (!s) return rec;
  const parts = readRegionParts('Regions6', s);
  return { ...rec, subs: [writeRegionParts({ ...parts, shapeBased: true, closing: undefined }), ...rec.subs.slice(1)] };
}

/**
 * A text record that leaves its document (copied, placed from a library): its WideStrings6 index
 * means nothing elsewhere, so it goes, the words kept for the entry it gets on save.
 */
export function detachedText(rec: PcbRawRecord, words?: string): PcbRawRecord {
  const s = rec.subs[0];
  if (rec.tag !== PCB_TAG.TEXT || !s || s.length < TEXT.wideIndex.off + 4 || get(s, TEXT.wideIndex) === 0xffffffff) return rec;
  const s0 = s.slice();
  put(s0, TEXT.wideIndex, 0xffffffff);
  return { ...rec, subs: [s0, ...rec.subs.slice(1)], ...(words !== undefined ? { wide: words } : {}) };
}

/**
 * Texts with no WideStrings6 entry (index 0xFFFFFFFF, as Konium makes them) get one: the next
 * index, the text in UTF-16 with its NUL; WideStrings6 is rewritten with the new entries. The
 * records returned are copies; the document is left as it is.
 */
export function withWideStrings(root: CfbEntry, texts: PcbRawRecord[]): PcbRawRecord[] {
  const wants = (r: PcbRawRecord) => r.tag === PCB_TAG.TEXT && !!r.subs[0] && r.subs[0].length >= TEXT.wideIndex.off + 4 && get(r.subs[0], TEXT.wideIndex) === 0xffffffff;
  if (!texts.some(wants)) return texts;
  const old = cfbStream(root, 'WideStrings6/Data') ?? new Uint8Array(0);
  const have = parseWideStrings(old);
  let next = have.size ? Math.max(...have.keys()) + 1 : 0, count = have.size;
  const w = new BinWriter(old.length + 1024).bytes(old);
  const out = texts.map((r) => {
    if (!wants(r)) return r;
    const s = r.subs[0]!.slice();
    const text = r.wide ?? decodeTextString(r.subs[1]);
    // An empty text's entry carries no bytes (as AD's do: a length of 2 or less has none)
    const u = text.length ? new Uint8Array((text.length + 1) * 2) : new Uint8Array(0);
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); u[2 * i] = c & 0xff; u[2 * i + 1] = c >> 8; }
    w.u32(next).u32(u.length).bytes(u);
    put(s, TEXT.wideIndex, next++); count++;
    return { tag: r.tag, subs: [s, ...r.subs.slice(1)] };
  });
  cfbPut(root, 'WideStrings6/Data', w.finish());
  cfbPut(root, 'WideStrings6/Header', countHeader(count));
  return out;
}

/* ─── Encoders (patch a template record) ─────────────────────────────────────────────── */

export interface TrackFields { layer: LayerId; a: Vec2; b: Vec2; width: number; net?: number; component?: number; polygon?: number; /** A keepout track (its second flag byte 2). */ keepout?: boolean }

/**
 * Build a track record. If the document already has tracks, the first one is cloned as
 * the template so unknown bytes match what this file's Altium version writes.
 */
export function encodeTrack(t: TrackFields, template?: PcbRawRecord): PcbRawRecord {
  const base = template?.subs[0];
  const s = base ? base.slice() : new Uint8Array(TRACK.templateLen);
  if (!base) { freshHeader(s); put(s, TRACK.subpoly, 0); }
  put(s, TRACK.layer, v6Layer(t.layer));
  put(s, TRACK.flags2, t.keepout ? 2 : 0);
  put(s, TRACK.net, t.net ?? 0xffff);
  put(s, TRACK.polygon, t.polygon ?? 0xffff);
  put(s, TRACK.component, t.component ?? 0xffff);
  put(s, TRACK.x1, t.a.x); put(s, TRACK.y1, t.a.y);
  put(s, TRACK.x2, t.b.x); put(s, TRACK.y2, t.b.y);
  put(s, TRACK.width, t.width);
  if (s.length >= TRACK.layerV7.off + 4) put(s, TRACK.layerV7, toV7(t.layer));
  return { tag: PCB_TAG.TRACK, subs: [s] };
}

/** The 8-bit V6 layer byte: layers past it (Mechanical 17–32) have none [est: 0 as AD17 leaves it]. */
/** The V6 layer byte: mechanical layers past 16 are written as Mechanical 16, as AD17 does (their V7 id says which). */
const v6Layer = (l: LayerId): number => (l <= 82 ? l : l > 1000 ? L.MECH16 : 0);

/** The V7 (32-bit) layer field a record's main subrecord carries, when it is long enough for it. */
export function v7FieldOf(tag: number, s: Uint8Array): Field | null {
  const fl = tag === PCB_TAG.TRACK ? TRACK.layerV7 : tag === PCB_TAG.ARC ? ARC.layerV7 : tag === PCB_TAG.FILL ? FILL.layerV7
    : tag === PCB_TAG.TEXT ? TEXT.layerV7 : tag === PCB_TAG.PAD ? PAD.layerV7 : null;
  return fl && s.length >= fl.off + 4 ? fl : null;
}
/** Put a primitive's main subrecord (a pad's fifth) on `layer`: the byte and, where it has one, the V7 id AD17 reads first. */
export function putLayer(tag: number, s: Uint8Array, layer: LayerId): void {
  s[0] = v6Layer(layer);
  const fl = v7FieldOf(tag, s);
  if (fl) put(s, fl, toV7(layer));
}

export function toV7(l: LayerId): number {
  if (l === L.TOP) return 0x01000001;
  if (l === L.BOTTOM) return 0x0100ffff;
  if (l > L.TOP && l < L.BOTTOM) return 0x01000000 + l;
  if (l >= L.PLANE1 && l <= L.PLANE16) return 0x01010000 + (l - L.PLANE1 + 1);
  if (l >= L.MECH1 && l <= L.MECH16) return 0x01020000 + (l - L.MECH1 + 1);
  if (l > 1000) return 0x01020000 + (l - 1000);
  const v8: Record<number, number> = { [L.TOP_OVERLAY]: 6, [L.BOTTOM_OVERLAY]: 7, [L.TOP_PASTE]: 8, [L.BOTTOM_PASTE]: 9,
    [L.TOP_SOLDER]: 10, [L.BOTTOM_SOLDER]: 11, [L.DRILL_GUIDE]: 12, [L.KEEPOUT]: 13, [L.DRILL_DRAWING]: 14, [L.MULTI]: 15 };
  return v8[l] !== undefined ? 0x01030000 + v8[l]! : 0;
}

const blank = (n: number) => new Uint8Array(n);
/** An 8-bit (cp1252) Pascal string; the Unicode words go to WideStrings6. */
function pascalBytes(s: string): Uint8Array {
  const bin = toCp1252Lossy(s).slice(0, 255);
  const b = new Uint8Array(bin.length + 1);
  b[0] = bin.length;
  for (let i = 0; i < bin.length; i++) b[i + 1] = bin.charCodeAt(i);
  return b;
}

export function encodeArc(a: { layer: LayerId; c: Vec2; r: number; start: number; end: number; width: number; net?: number; component?: number }, template?: PcbRawRecord): PcbRawRecord {
  const s = template?.subs[0]?.slice() ?? blank(ARC.templateLen);
  if (!template) { freshHeader(s); put(s, ARC.subpoly, 0); }
  putLayer(PCB_TAG.ARC, s, a.layer); put(s, ARC.net, a.net ?? 0xffff); put(s, ARC.component, a.component ?? 0xffff);
  put(s, ARC.cx, a.c.x); put(s, ARC.cy, a.c.y); put(s, ARC.radius, a.r);
  put(s, ARC.start, a.start); put(s, ARC.end, a.end); put(s, ARC.width, a.width);
  return { tag: PCB_TAG.ARC, subs: [s] };
}

export function encodeVia(v: { at: Vec2; diameter: number; hole: number; net?: number; layerStart?: LayerId; layerEnd?: LayerId }, template?: PcbRawRecord): PcbRawRecord {
  const s = template?.subs[0]?.slice() ?? blank(VIA.templateLen);
  if (!template) { freshHeader(s); s[0] = L.MULTI; }
  putPlaneRelief(s, VIA.relief, AD_PLANE_RELIEF, true);
  put(s, VIA.net, v.net ?? 0xffff); put(s, VIA.x, v.at.x); put(s, VIA.y, v.at.y);
  // The template's own diameter keeps its per-layer stack (Top-Middle-Bottom, Full Stack)
  if (!template || get(s, VIA.diameter) !== v.diameter) setViaDiameter(s, v.diameter);
  put(s, VIA.hole, v.hole);
  put(s, VIA.layerStart, v.layerStart ?? L.TOP); put(s, VIA.layerEnd, v.layerEnd ?? L.BOTTOM);
  return { tag: PCB_TAG.VIA, subs: [s] };
}

export function encodeFill(f: { layer: LayerId; a: Vec2; b: Vec2; rotation?: number; net?: number; component?: number }, template?: PcbRawRecord): PcbRawRecord {
  const s = template?.subs[0]?.slice() ?? blank(FILL.templateLen);
  if (!template) freshHeader(s);
  putLayer(PCB_TAG.FILL, s, f.layer); put(s, FILL.net, f.net ?? 0xffff); put(s, FILL.component, f.component ?? 0xffff);
  put(s, FILL.x1, f.a.x); put(s, FILL.y1, f.a.y); put(s, FILL.x2, f.b.x); put(s, FILL.y2, f.b.y);
  put(s, FILL.rotation, f.rotation ?? 0);
  return { tag: PCB_TAG.FILL, subs: [s] };
}

/** A barcode String's settings from its record (≥ TEXT.barcodeLen bytes). */
export function barcodeOf(s: Uint8Array): BarcodeSpec {
  const g = (fl: Parameters<typeof get>[1]) => get(s, fl) ?? 0;
  return {
    type: g(TEXT.bcType) === 1 ? 'code128' : 'code39', render: g(TEXT.bcRender) === 0 ? 'min' : 'full',
    fullWidth: g(TEXT.bcFullWidth), height: g(TEXT.bcHeight), minWidth: g(TEXT.bcMinWidth), marginX: g(TEXT.bcMarginX), marginY: g(TEXT.bcMarginY),
    inverted: g(TEXT.bcInverted) !== 0, showText: g(TEXT.bcShowText) !== 0, font: utf16le(s.subarray(TEXT.bcFont, TEXT.bcFont + 64)) || 'Arial',
  };
}

/**
 * A text record made long enough for AD17's later fields (barcode settings, V7 layer), with the
 * values AD17 gives every text there; `s` unchanged when it already is.
 */
export function longText(s: Uint8Array): Uint8Array {
  if (s.length >= TEXT.barcodeLen) return s;
  const o = new Uint8Array(252);
  o.set(s.subarray(0, Math.min(s.length, 137)));
  if (s.length < TEXT.extendedLen) put(o, TEXT.wideIndex, 0xffffffff);
  put(o, TEXT.bcFullWidth, 10_500_000); put(o, TEXT.bcHeight, 2_100_000); put(o, TEXT.bcMarginX, 200_000); put(o, TEXT.bcMarginY, 200_000);
  put(o, TEXT.bcRender, 1); put(o, TEXT.bcInverted, 1); put(o, TEXT.kind, o[TEXT.fontType.off]!); put(o, TEXT.bcShowText, 1);
  const font = 'Arial';
  for (let i = 0; i < font.length; i++) o[TEXT.bcFont + 2 * i] = font.charCodeAt(i);
  put(o, TEXT.layerV7, toV7(layerOf(get(o, TEXT.layer))));
  return o;
}

export function encodeText(t: { layer: LayerId; at: Vec2; height: number; text: string; rotation?: number; strokeWidth?: number; component?: number; mirrored?: boolean; isDesignator?: boolean; isComment?: boolean;
  /** A TrueType font (else the stroke font), and whether the text is inverted (cut out of a filled box). */
  trueType?: { name: string; bold?: boolean; italic?: boolean; inverted?: boolean } }, template?: PcbRawRecord, keepFont = false): PcbRawRecord {
  // A layer past AD's first 16 mechanical ones is kept in the longer record's V7 layer
  const s = template?.subs[0]?.slice() ?? blank(t.layer > 82 ? TEXT.barcodeLen : TEXT.templateLen);
  if (!template) { freshHeader(s); put(s, TEXT.net, 0xffff); }
  put(s, TEXT.isDesignator, t.isDesignator ? 1 : 0); put(s, TEXT.isComment, t.isComment ? 1 : 0);
  put(s, TEXT.layer, v6Layer(t.layer)); put(s, TEXT.component, t.component ?? 0xffff);
  if (s.length >= TEXT.barcodeLen) put(s, TEXT.layerV7, toV7(t.layer));
  put(s, TEXT.x, t.at.x); put(s, TEXT.y, t.at.y); put(s, TEXT.height, t.height);
  if (!keepFont) put(s, TEXT.font, 1);
  put(s, TEXT.rotation, t.rotation ?? 0); put(s, TEXT.mirrored, t.mirrored ? 1 : 0);
  put(s, TEXT.strokeWidth, t.strokeWidth ?? Math.round(t.height / 10));
  if (t.trueType && s.length >= TEXT.extendedLen) {
    put(s, TEXT.fontType, 1); put(s, TEXT.bold, t.trueType.bold ? 1 : 0); put(s, TEXT.italic, t.trueType.italic ? 1 : 0); put(s, TEXT.inverted, t.trueType.inverted ? 1 : 0);
    const name = t.trueType.name.slice(0, 31);
    s.fill(0, TEXT.fontName, TEXT.fontName + 64);
    for (let i = 0; i < name.length; i++) { const c = name.charCodeAt(i); s[TEXT.fontName + 2 * i] = c & 0xff; s[TEXT.fontName + 2 * i + 1] = c >> 8; }
    if (s.length >= TEXT.barcodeLen) put(s, TEXT.kind, 1);
  }
  // A new text has no WideStrings6 entry: an index left over from a template (or 0) would show another text
  if (s.length >= TEXT.wideIndex.off + 4) put(s, TEXT.wideIndex, 0xffffffff);
  return { tag: PCB_TAG.TEXT, subs: [s, pascalBytes(t.text)], wide: t.text };
}

export interface PadFields {
  name: string; layer: LayerId; at: Vec2; w: number; h: number; shape: 'round' | 'rect' | 'octagon' | 'roundrect';
  hole?: number; rotation?: number; net?: number; component?: number;
  /** Rounded rectangle: its corner radius as a percentage of half the shorter side. */
  cornerPct?: number;
  /** A slotted hole: its length (the hole is its width) and its turn from the pad's. */
  slot?: { length: number; rotation: number };
  /** An unplated hole (plated when it has one, unless said). */
  plated?: boolean;
  /** Top-Middle-Bottom: the middle's and the bottom's sizes and shapes (the top's are w, h, shape). */
  mid?: { w: number; h: number; shape: PadFields['shape'] }; bot?: { w: number; h: number; shape: PadFields['shape'] };
  /** Specified solder and paste mask expansions (else the rules'). */
  solderExpansion?: number; pasteExpansion?: number;
  /** Jumper ID (pads of a component with the same one are joined inside it: a wire link); the template's when absent. */
  jumper?: number;
}

export function encodePad(p: PadFields, template?: PcbRawRecord): PcbRawRecord {
  const s = template?.subs[4]?.slice() ?? blank(PAD.templateLen);
  if (!template) freshHeader(s);
  putPlaneRelief(s, PAD.relief, AD_PLANE_RELIEF, (p.hole ?? 0) > 0);
  const shape = { round: 1, rect: 2, octagon: 3, roundrect: 2 }[p.shape];
  putLayer(PCB_TAG.PAD, s, p.layer); put(s, PAD.net, p.net ?? 0xffff); put(s, PAD.component, p.component ?? 0xffff);
  put(s, PAD.x, p.at.x); put(s, PAD.y, p.at.y);
  // A template already of this size and shape (a default) keeps its stack: Top-Middle-Bottom, Full Stack, plating
  const same = !!template && get(s, PAD.topX) === p.w && get(s, PAD.topY) === p.h && get(s, PAD.topShape) === shape && get(s, PAD.hole) === (p.hole ?? 0);
  if (!same || p.mid || p.bot) {
    const SH = { round: 1, rect: 2, octagon: 3, roundrect: 2 };
    const layers = [[PAD.topX, PAD.topY, PAD.topShape, p], [PAD.midX, PAD.midY, PAD.midShape, p.mid ?? p], [PAD.botX, PAD.botY, PAD.botShape, p.bot ?? p]] as const;
    for (const [fx, fy, fs, q] of layers) { put(s, fx, q.w); put(s, fy, q.h); put(s, fs, SH[q.shape]); }
    put(s, PAD.hole, p.hole ?? 0); put(s, PAD.plated, p.hole && p.plated !== false ? 1 : 0); put(s, PAD.padMode, p.mid || p.bot ? 1 : 0);
  }
  if (p.solderExpansion !== undefined) { put(s, PAD.solderManual, p.solderExpansion); put(s, PAD.solderMode, 2); }
  if (p.pasteExpansion !== undefined) { put(s, PAD.pasteManual, p.pasteExpansion); put(s, PAD.pasteMode, 2); }
  if (p.jumper !== undefined && s.length >= PAD.jumperId.off + 2) put(s, PAD.jumperId, p.jumper);
  put(s, PAD.rotation, p.rotation ?? 0);
  // The three short subrecords between name and pad: the template's, else AD17's (0, "|&|0", 0)
  const mid = template && template.subs.length >= 4 ? template.subs.slice(1, 4).map((x) => x.slice()) : [new Uint8Array([0]), new Uint8Array([4, 0x7c, 0x26, 0x7c, 0x30]), new Uint8Array([0])];
  let stack: Uint8Array = same && (template!.subs[5]?.length ?? 0) > 0 ? template!.subs[5]!.slice() : blank(0);
  if (p.shape === 'roundrect' || p.mid?.shape === 'roundrect' || p.bot?.shape === 'roundrect' || p.slot) stack = padStack(p, shape);
  return { tag: PCB_TAG.PAD, subs: [pascalBytes(p.name), ...mid, s, stack] };
}

/**
 * The pad's size-and-shape block (AD's SizeAndShape, after the pad record): every inner layer's
 * size and shape as the middle's, the hole's shape (2: slot) with its length and turn, and each
 * layer's alternative shape (9: rounded rectangle) and corner radius percentage.
 */
function padStack(p: PadFields, shape: number): Uint8Array {
  const b = new Uint8Array(PAD_STACK.minLen);
  const dv = new DataView(b.buffer);
  const m = p.mid ?? p, mShape = { round: 1, rect: 2, octagon: 3, roundrect: 2 }[m.shape];
  for (let i = 0; i < 29; i++) {
    dv.setInt32(PAD_STACK.innerX + i * 4, Math.round(m.w), true);
    dv.setInt32(PAD_STACK.innerY + i * 4, Math.round(m.h), true);
    b[PAD_STACK.innerShape + i] = mShape;
  }
  if (p.slot) {
    b[PAD_STACK.holeShape] = 2;
    dv.setInt32(PAD_STACK.slotLength, Math.round(p.slot.length), true);
    dv.setFloat64(PAD_STACK.slotRotation, p.slot.rotation, true);
  }
  void shape;
  for (let l = 0; l < 32; l++) {
    const q = l === 0 ? p : l === 31 ? p.bot ?? p : m;
    b[PAD_STACK.altShape + l] = q.shape === 'roundrect' ? 9 : { round: 1, rect: 2, octagon: 3, roundrect: 2 }[q.shape];
    b[PAD_STACK.cornerRadius + l] = q.shape === 'roundrect' ? Math.max(0, Math.min(100, Math.round(p.cornerPct ?? 50))) : 0;
  }
  return b;
}

export interface RegionFields {
  layer: LayerId; outline: Vec2[]; holes?: Vec2[][]; net?: number; polygon?: number; component?: number;
  kind?: number; /** ShapeBasedRegions6 encoding (int vertices, optional arcs) */ shapeBased?: boolean;
  arcs?: Map<number, { c: Vec2; r: number; a1: number; a2: number }>;
  /** Design › Board Shape › Define Board Cutout: a hole through the board (ISBOARDCUTOUT). */
  boardCutout?: boolean;
  /** More properties (KONIUMPADSHAPE for a polygon pad's shape). */
  extra?: Record<string, string>;
}

/** Encode a Regions6 / ShapeBasedRegions6 record (header, property block, vertices, holes). */
export function encodeRegion(f: RegionFields): PcbRawRecord {
  const w = new BinWriter(256);
  // Header as AD17 writes it: flags 0x0c, net, polygon, component, 0xFFFFFFFF, 0, hole count, 0
  w.u8(f.layer <= 82 ? f.layer : 0).u8(0x0c).u8(0).u16(f.net ?? 0xffff).u16(f.polygon ?? 0xffff).u16(f.component ?? 0xffff)
    .u32(0xffffffff).u8(0).u16(f.holes?.length ?? 0).zeros(2);
  const props = PropertyBag.from({ V7_LAYER: layerToName(f.layer), NAME: ' ', KIND: f.kind ?? 0, SUBPOLYINDEX: -1, UNIONINDEX: 0, ARCRESOLUTION: '0.5mil', ISSHAPEBASED: f.shapeBased ? 'TRUE' : 'FALSE', CAVITYHEIGHT: '0mil',
    ...(f.boardCutout ? { ISBOARDCUTOUT: 'TRUE' } : {}), ...(f.extra ?? {}) }).toBytes();
  w.u32(props.length).bytes(props);
  w.u32(f.outline.length);
  const verts = f.shapeBased ? [...f.outline, f.outline[0]!] : f.outline;
  verts.forEach((p, i) => {
    if (f.shapeBased) {
      const arc = f.arcs?.get(i);
      w.u8(arc ? 1 : 0).i32(p.x).i32(p.y).i32(arc?.c.x ?? 0).i32(arc?.c.y ?? 0).i32(arc?.r ?? 0).f64(arc?.a1 ?? 0).f64(arc?.a2 ?? 0);
    } else w.f64(p.x).f64(p.y);
  });
  for (const h of f.holes ?? []) { w.u32(h.length); for (const p of h) w.f64(p.x).f64(p.y); }
  return { tag: PCB_TAG.REGION, subs: [w.finish()] };
}

export interface BodyFields {
  component: number; outline: Vec2[]; standoff: number; overall: number; colour: number;
  layer?: LayerId; bottom?: boolean; opacity?: number; at?: Vec2; id?: string;
  /** MODEL.MODELTYPE: 0 extruded (the default), 2 cylinder, 3 sphere; `extra` adds their keys. */
  modelType?: number; identifier?: string; extra?: Record<string, string | number>;
}

/**
 * A ComponentBodies6 record for an extruded 3D body (MODEL.MODELTYPE 0): the region-style
 * header and property block Altium writes, then the outline as f64 pairs. `colour` is a
 * Windows COLORREF (0x00BBGGRR).
 */
export function encodeBody(f: BodyFields): PcbRawRecord {
  const w = new BinWriter(256);
  const layer = f.layer ?? L.MECH1;
  w.u8(layer <= 82 ? layer : 0).u8(0x0c).u8(0).u16(0xffff).u16(0xffff).u16(f.component).u32(0xffffffff).zeros(5);
  const at = f.at ?? f.outline[0]!;
  const len = (v: number) => formatAltiumLength(v);
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).toUpperCase().padStart(4, '0');
  const id = f.id ?? `{${hex()}${hex()}-${hex()}-${hex()}-${hex()}-${hex()}${hex()}${hex()}}`;
  const props = PropertyBag.from({
    V7_LAYER: layerToName(layer), NAME: ' ', KIND: 0, SUBPOLYINDEX: -1, UNIONINDEX: 0, ARCRESOLUTION: '0.5mil', ISSHAPEBASED: 'FALSE', CAVITYHEIGHT: '0mil',
    STANDOFFHEIGHT: len(f.standoff), OVERALLHEIGHT: len(f.overall), BODYPROJECTION: f.bottom ? 1 : 0, BODYCOLOR3D: f.colour,
    BODYOPACITY3D: (f.opacity ?? 1).toFixed(3), IDENTIFIER: bodyIdentifierValue(f.identifier ?? ''), TEXTURE: '', TEXTURECENTERX: '0mil', TEXTURECENTERY: '0mil', TEXTURESIZEX: '0mil', TEXTURESIZEY: '0mil',
    TEXTUREROTATION: ' 0.00000000000000E+0000', MODELID: id, 'MODEL.CHECKSUM': 0, 'MODEL.EMBED': 'FALSE', 'MODEL.NAME': '',
    'MODEL.2D.X': len(at.x), 'MODEL.2D.Y': len(at.y), 'MODEL.2D.ROTATION': '0.000', 'MODEL.3D.ROTX': '0.000', 'MODEL.3D.ROTY': '0.000', 'MODEL.3D.ROTZ': '0.000',
    'MODEL.3D.DZ': '0mil', 'MODEL.MODELTYPE': f.modelType ?? 0, 'MODEL.EXTRUDED.MINZ': len(f.standoff), 'MODEL.EXTRUDED.MAXZ': len(f.overall),
    ...f.extra,
  }).toBytes();
  w.u32(props.length).bytes(props);
  w.u32(f.outline.length);
  for (const p of f.outline) w.f64(p.x).f64(p.y);
  return { tag: PCB_TAG.MODEL, subs: [w.finish()] };
}

export function layerToName(l: LayerId): string {
  if (l === L.TOP) return 'TOP';
  if (l === L.BOTTOM) return 'BOTTOM';
  if (l > L.TOP && l < L.BOTTOM) return `MID${l - 1}`;
  if (l >= L.PLANE1 && l <= L.PLANE16) return `PLANE${l - L.PLANE1 + 1}`;
  if ((l >= L.MECH1 && l <= L.MECH16) || l > 1000) return `MECHANICAL${l > 1000 ? l - 1000 : l - L.MECH1 + 1}`;
  return ({ [L.TOP_OVERLAY]: 'TOPOVERLAY', [L.BOTTOM_OVERLAY]: 'BOTTOMOVERLAY', [L.TOP_PASTE]: 'TOPPASTE', [L.BOTTOM_PASTE]: 'BOTTOMPASTE',
    [L.TOP_SOLDER]: 'TOPSOLDER', [L.BOTTOM_SOLDER]: 'BOTTOMSOLDER', [L.DRILL_GUIDE]: 'DRILLGUIDE', [L.KEEPOUT]: 'KEEPOUT',
    [L.DRILL_DRAWING]: 'DRILLDRAWING', [L.MULTI]: 'MULTILAYER' } as Record<number, string>)[l] ?? 'TOP';
}
