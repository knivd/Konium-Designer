/**
 * AD's ASCII PCB document (File › Save As › PCB ASCII File, *.PcbDoc): every record a line of
 * |KEY=VALUE pairs, CR LF between records, a long record (the board, the printer options) carried
 * on after a bare CR with its RECORD= again. What the binary file keeps as property records (the
 * board, its options, classes, nets, components, rules, polygons, dimensions) are those records
 * with RECORD=, ID= and INDEXFORSAVE= in front; regions and 3D bodies their property block with
 * their vertices; tracks, arcs, pads, vias, fills and texts are spelled out by their fields.
 * Read, the records become a binary PcbDoc's streams; written, a PcbDoc becomes those lines (what
 * Cadence's translators for AD boards read). [est] Keys from AD-saved ASCII boards; vias, fills and
 * pad stacks by AD's names for them.
 */
import { cfbPut, cfbStream, newEntry, writeCfb } from '../cfb/cfb';
import { BinWriter } from '../bin';
import { binToBytes, bytesToBin } from '../text';
import { countHeader, joinBinaryRecords, joinTextRecords, PCB_TAG, splitBinaryRecords, splitTextRecords, type PcbRawRecord } from './framing';
import { PropertyBag } from './props';
import { defaultRules, joinRuleRecords, type PcbRule } from './rules';
import { TEARDROP_FLAG, encodeArc, encodeFill, encodePad, encodeText, encodeTrack, encodeVia, layerFromName, layerToName, readPcbDoc, writePcbDoc, type PadFields } from './pcbdoc';
import { readRegionParts, writeRegionParts, type RegionParts, type RegionVertex } from './regionRecord';
import { altiumFloat } from './pcbTransform';
import { FLAG, get, PAD, PAD_STACK, put, TRACK, ARC, FILL, VIA, REGION, TEXT, type Field } from './pcbLayouts';
import { dimensionFromBag, joinDimensions } from '../../model/dimensions';
import { formatAltiumLength, parseLength } from '../../core/units';
import { L, type LayerId } from '../../model/layers';
import { NO_NET, type PcbDocument, type PcbPrim } from '../../model/pcb';

/** A file that starts as AD's ASCII PCB documents do. */
export function isPcbAscii(b: Uint8Array): boolean {
  const h = bytesToBin(b.subarray(0, 24));
  return /^\|?RECORD=Board\|/i.test(h);
}

/** The option records AD keeps each in a storage of its own. */
const OPTIONS = ['EngineeringChangeOrderOptions', 'OutputOptions', 'PrinterOptions', 'GerberOptions', 'AdvancedPlacerOptions', 'DesignRuleCheckerOptions', 'PinSwapOptions', 'TestpointOptions'];
const SHAPE_NAMES: Record<string, PadFields['shape']> = { ROUND: 'round', RECTANGLE: 'rect', RECTANGULAR: 'rect', OCTAGONAL: 'octagon', OCTAGON: 'octagon', ROUNDEDRECTANGLE: 'roundrect', ROUNDRECT: 'roundrect' };
const SHAPE_OF: Record<string, string> = { round: 'ROUND', rect: 'RECTANGLE', octagon: 'OCTAGONAL', roundrect: 'ROUNDEDRECTANGLE' };

type Entry = [string, string];

/* ───────────────────────────── reading ───────────────────────────── */

interface Rec { kind: string; entries: Entry[] }

/** The records: lines (CR LF, or LF), each continued after a bare CR. */
function records(text: string): Rec[] {
  const out: Rec[] = [];
  for (const line of text.split(/\r\n|\n/)) {
    if (!line.trim()) continue;
    const entries: Entry[] = [];
    let kind = '';
    line.split('\r').forEach((chunk, ci) => {
      for (const part of chunk.replace(/^\|/, '').split('|')) {
        if (!part) continue;
        const eq = part.indexOf('=');
        const k = eq < 0 ? part : part.slice(0, eq), v = eq < 0 ? '' : part.slice(eq + 1);
        if (k.toUpperCase() === 'RECORD') { if (!kind) { kind = v; continue; } if (ci > 0 && v === kind && entries.length) { entries.push([k, v]); continue; } }
        entries.push([k, v]);
      }
    });
    if (kind) out.push({ kind, entries });
  }
  return out;
}

const bagOf = (entries: Entry[], drop: string[] = []): PropertyBag => {
  const skip = new Set(drop.map((d) => d.toUpperCase()));
  const bag = PropertyBag.fromEntries(entries.filter(([k]) => !skip.has(k.toUpperCase())));
  return PropertyBag.parse(bag.toBytes());
};

class Fields {
  private m = new Map<string, string>();
  constructor(entries: Entry[]) { for (const [k, v] of entries) if (!this.m.has(k.toUpperCase())) this.m.set(k.toUpperCase(), v); }
  has(k: string): boolean { return this.m.has(k.toUpperCase()); }
  str(k: string, d = ''): string { return this.m.get(k.toUpperCase()) ?? d; }
  /** A length: "12.5mil", "0.3mm", or a bare number of mils. */
  len(k: string, d = 0): number {
    const v = this.m.get(k.toUpperCase())?.trim();
    if (!v) return d;
    return /[a-z]/i.test(v) ? parseLength(v) ?? d : Math.round(Number(v) * 10000) || d;
  }
  num(k: string, d = 0): number { const v = Number(this.m.get(k.toUpperCase())?.trim()); return Number.isFinite(v) ? v : d; }
  bool(k: string): boolean { return /^(T|TRUE)$/i.test(this.m.get(k.toUpperCase())?.trim() ?? ''); }
  layer(k = 'LAYER', d: LayerId = L.TOP): LayerId { return layerFromName(this.str(k)) ?? d; }
  idx(k: string): number { return this.m.has(k.toUpperCase()) ? Math.round(this.num(k, NO_NET)) : NO_NET; }
}

/** The outline vertices (KIND0, VX0 … R0, …) as a region's stored vertices. */
function vertsOf(f: Fields, max = Infinity): RegionVertex[] {
  const out: RegionVertex[] = [];
  for (let i = 0; i < max && f.has(`VX${i}`); i++) {
    const v: RegionVertex = { x: f.len(`VX${i}`), y: f.len(`VY${i}`) };
    const arc = { cx: f.len(`CX${i}`), cy: f.len(`CY${i}`), r: f.len(`R${i}`), a1: f.num(`SA${i}`), a2: f.num(`EA${i}`) };
    if (f.num(`KIND${i}`) === 1 && arc.r > 0) v.arc = arc; else v.rest = arc;
    out.push(v);
  }
  return out;
}

/** A region's or body's record: the fixed header, its property block, its vertices and holes. */
function regionRecord(f: Fields, bag: PropertyBag, body: boolean, boardRegion = false): { rec: PcbRawRecord; shapeBased: boolean } {
  const layer = boardRegion ? f.layer('LAYER', L.KEEPOUT) : f.layer('V7_LAYER', f.layer());
  const shapeBased = !body && f.bool('ISSHAPEBASED');
  const count = f.has('MAINCONTOURVERTEXCOUNT') ? f.num('MAINCONTOURVERTEXCOUNT') : Infinity;
  let verts = vertsOf(f, Number.isFinite(count) ? count + 1 : Infinity);
  // Stored without its closing vertex (a shape-based region keeps it apart, its own arc fields as written)
  let closing: RegionVertex | undefined;
  if (verts.length > 2) { const a = verts[0]!, b = verts.at(-1)!; if (Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2) { closing = verts.at(-1); verts = verts.slice(0, -1); } }
  if (!shapeBased) verts = verts.map((v) => ({ x: v.x, y: v.y }));
  if (shapeBased && !closing && verts[0]) closing = { x: verts[0].x, y: verts[0].y, rest: { cx: 0, cy: 0, r: 0, a1: 0, a2: 0 } };
  const holes: { x: number; y: number }[][] = [];
  for (let h = 0; h < f.num('HOLECOUNT'); h++) {
    const n = f.num(`HOLE${h}VERTEXCOUNT`), pts = [];
    for (let i = 0; i < n; i++) pts.push({ x: f.num(`H${h}VX${i}`), y: f.num(`H${h}VY${i}`) });
    holes.push(pts);
  }
  const head = new BinWriter(32);
  head.u8(layer <= 82 ? layer : 0).u8((f.bool('LOCKED') ? 0x08 : 0x0c) | (!body && f.bool('TEARDROP') ? TEARDROP_FLAG : 0)).u8(!boardRegion && f.bool('KEEPOUT') ? 2 : 0)
    .u16(body ? NO_NET : f.idx('NET')).u16(body ? NO_NET : f.idx('POLYGON')).u16(f.idx('COMPONENT')).u32(0xffffffff).u8(0).u16(holes.length).zeros(2);
  if (!bag.has('V7_LAYER')) bag.set('V7_LAYER', layerToName(layer));
  const parts: RegionParts = { shapeBased, head: head.finish().slice(0, REGION.propsAt), props: bag, propHigh: 0, verts, holes, tail: new Uint8Array(0), closing: shapeBased ? closing : undefined };
  return { rec: { tag: body ? PCB_TAG.MODEL : PCB_TAG.REGION, subs: [writeRegionParts(parts)] }, shapeBased };
}

/** The keys a primitive's line carries that its binary record keeps in fixed fields. */
const PRIM_KEYS = ['RECORD', 'ID', 'INDEXFORSAVE', 'SELECTION', 'LAYER', 'LOCKED', 'POLYGONOUTLINE', 'USERROUTED', 'KEEPOUT', 'NET', 'COMPONENT', 'POLYGON',
  'SOLDERMASKEXPANSIONMODE', 'PASTEMASKEXPANSIONMODE', 'MAINCONTOURVERTEXCOUNT', 'HOLECOUNT', 'TEARDROP'];
const vertexKey = (k: string) => /^(KIND|VX|VY|CX|CY|SA|EA|R)\d+$/i.test(k) || /^HOLE\d+VERTEXCOUNT$/i.test(k) || /^H\d+V[XY]\d+$/i.test(k);

const lockFlags = (s: Uint8Array, fl: Field, f: Fields) => { if (f.has('LOCKED')) { const v = get(s, fl) ?? 0; put(s, fl, f.bool('LOCKED') ? v & ~0x04 : v | 0x04); } };

export function readPcbAscii(bytes: Uint8Array, name: string): PcbDocument {
  const recs = records(bytesToBin(bytes));
  const root = newEntry('Root Entry', 'root');
  const fh = new BinWriter(32).u32(19);
  for (const ch of 'PCB 5.0 Bi') fh.u8(ch.charCodeAt(0)).u8(0);
  cfbPut(root, 'FileHeader', fh.finish());
  const six = binToBytes('PCB 6.0 Binary File');
  cfbPut(root, 'FileHeaderSix', new BinWriter(32).u32(six.length).u8(six.length).bytes(six).f64(5.01).finish());
  const by = (k: string) => recs.filter((r) => r.kind.toLowerCase() === k.toLowerCase());
  const putText = (s: string, bags: PropertyBag[]) => { cfbPut(root, `${s}/Header`, countHeader(bags.length)); cfbPut(root, `${s}/Data`, joinTextRecords(bags)); };
  const putBin = (s: string, list: PcbRawRecord[]) => { cfbPut(root, `${s}/Header`, countHeader(list.length)); cfbPut(root, `${s}/Data`, joinBinaryRecords(list)); };
  const notes: string[] = [];

  // Property records
  const board = by('Board')[0];
  putText('Board6', [board ? bagOf(board.entries) : PropertyBag.from({ KIND: 'Protel_Advanced_PCB', VERSION: '5.01' })]);
  for (const o of OPTIONS) { const r = by(o)[0]; if (r) putText(`${o}6`, [bagOf(r.entries)]); }
  putText('Nets6', by('Net').map((r) => bagOf(r.entries, ['ID', 'INDEXFORSAVE'])));
  putText('Components6', by('Component').map((r) => bagOf(r.entries, ['ID', 'INDEXFORSAVE'])));
  putText('Polygons6', by('Polygon').map((r) => bagOf(r.entries, ['ID', 'INDEXFORSAVE'])));
  const classes = by('Class');
  putText('Classes6', classes.map((r) => bagOf(r.entries, ['INDEXFORSAVE'])));
  putText('DifferentialPairs6', by('DifferentialPair').map((r) => bagOf(r.entries, ['INDEXFORSAVE'])));
  const dxp = by('DXPRule');
  const rules: PcbRule[] = dxp.map((r) => { const bag = bagOf(r.entries, ['INDEXFORSAVE']); return { prefix: new Uint8Array([2, 0]), bag }; });
  if (!dxp.length && by('Rule').length) notes.push('rules in the old form (no DXPRule records): the default rules used');
  const ruleList = rules.length ? rules : defaultRules();
  cfbPut(root, 'Rules6/Header', countHeader(ruleList.length));
  cfbPut(root, 'Rules6/Data', joinRuleRecords(ruleList));
  const dims = by('Dimension').map((r, i) => dimensionFromBag(bagOf(r.entries, ['INDEXFORSAVE']), i));
  cfbPut(root, 'Dimensions6/Header', countHeader(dims.length));
  cfbPut(root, 'Dimensions6/Data', joinDimensions(dims));

  // Primitives
  const tracks: PcbRawRecord[] = [], arcs: PcbRawRecord[] = [], pads: PcbRawRecord[] = [], vias: PcbRawRecord[] = [], fills: PcbRawRecord[] = [], texts: PcbRawRecord[] = [];
  const regions: PcbRawRecord[] = [], shapes: PcbRawRecord[] = [], bodies: PcbRawRecord[] = [], boardRegions: PcbRawRecord[] = [];
  const idx = (n: number) => (n === NO_NET ? undefined : n);
  for (const r of recs) {
    const f = new Fields(r.entries);
    switch (r.kind.toLowerCase()) {
      case 'track': {
        const rec = encodeTrack({ layer: f.layer(), a: { x: f.len('X1'), y: f.len('Y1') }, b: { x: f.len('X2'), y: f.len('Y2') }, width: f.len('WIDTH'), net: idx(f.idx('NET')), component: idx(f.idx('COMPONENT')), polygon: idx(f.idx('POLYGON')) });
        const s = rec.subs[0]!;
        if (f.bool('KEEPOUT')) put(s, TRACK.flags2, 2);
        lockFlags(s, TRACK.flags1, f);
        tracks.push(rec);
        break;
      }
      case 'arc': {
        const rec = encodeArc({ layer: f.layer(), c: { x: f.len('LOCATION.X'), y: f.len('LOCATION.Y') }, r: f.len('RADIUS'), start: f.num('STARTANGLE'), end: f.num('ENDANGLE'), width: f.len('WIDTH'), net: idx(f.idx('NET')), component: idx(f.idx('COMPONENT')) });
        const s = rec.subs[0]!;
        if (f.has('POLYGON')) put(s, ARC.polygon, f.idx('POLYGON'));
        if (f.bool('KEEPOUT')) put(s, ARC.flags2, 2);
        lockFlags(s, ARC.flags1, f);
        arcs.push(rec);
        break;
      }
      case 'via': {
        const d = f.len('DIAMETER', f.len('TOPLAYERSIZE', f.len('SIZE')));
        const rec = encodeVia({ at: { x: f.len('X'), y: f.len('Y') }, diameter: d, hole: f.len('HOLESIZE'), net: idx(f.idx('NET')), layerStart: f.layer('STARTLAYER', L.TOP), layerEnd: f.layer('ENDLAYER', L.BOTTOM) });
        const s = rec.subs[0]!;
        // (a footprint's own via: its part)
        put(s, VIA.component, idx(f.idx('COMPONENT')) ?? NO_NET);
        let fl = get(s, VIA.flags1) ?? 0;
        if (f.has('TENTINGTOP')) fl = f.bool('TENTINGTOP') ? fl | FLAG.tentTop : fl & ~FLAG.tentTop;
        if (f.has('TENTINGBOTTOM')) fl = f.bool('TENTINGBOTTOM') ? fl | FLAG.tentBottom : fl & ~FLAG.tentBottom;
        put(s, VIA.flags1, fl);
        lockFlags(s, VIA.flags1, f);
        vias.push(rec);
        break;
      }
      case 'fill': {
        const rec = encodeFill({ layer: f.layer(), a: { x: f.len('X1'), y: f.len('Y1') }, b: { x: f.len('X2'), y: f.len('Y2') }, rotation: f.num('ROTATION'), net: idx(f.idx('NET')), component: idx(f.idx('COMPONENT')) });
        const s = rec.subs[0]!;
        if (f.bool('KEEPOUT')) put(s, FILL.flags2, 2);
        lockFlags(s, FILL.flags1, f);
        fills.push(rec);
        break;
      }
      case 'text': {
        let text = f.str('TEXT');
        const wide = f.str('WIDESTRING');
        if (/^\d+(,\d+)*$/.test(wide)) text = String.fromCharCode(...wide.split(',').map(Number));
        const tt = f.bool('USETTFONTS') || f.num('TEXTKIND') === 1;
        texts.push(encodeText({ layer: f.layer(), at: { x: f.len('X'), y: f.len('Y') }, height: f.len('HEIGHT'), text, rotation: f.num('ROTATION'), strokeWidth: f.len('WIDTH'),
          component: idx(f.idx('COMPONENT')), mirrored: f.bool('MIRROR'), isDesignator: f.bool('DESIGNATOR'), isComment: f.bool('COMMENT'),
          trueType: tt ? { name: f.str('FONTNAME', 'Arial'), bold: f.bool('BOLD'), italic: f.bool('ITALIC'), inverted: f.bool('INVERTED') } : undefined }));
        const s = texts.at(-1)!.subs[0]!;
        if (!tt && s.length >= TEXT.extendedLen) { put(s, TEXT.bold, f.bool('BOLD') ? 1 : 0); put(s, TEXT.italic, f.bool('ITALIC') ? 1 : 0); }
        break;
      }
      case 'pad': {
        const size = (pre: string, alt: string, k: 'X' | 'Y') => f.len(`${pre}${k}SIZE`, f.len(`${alt}${k}SIZE`, f.len(`${k}SIZE`)));
        const shape = (pre: string) => SHAPE_NAMES[(f.str(`${pre}SHAPE`) || f.str('SHAPE', 'ROUND')).toUpperCase()] ?? 'round';
        const mode = f.num('PADMODE');
        const hole = f.len('HOLESIZE');
        const slot = f.num('HOLETYPE') === 2 && f.len('HOLEWIDTH') > hole ? { length: f.len('HOLEWIDTH'), rotation: f.num('HOLEROTATION') } : undefined;
        const pct = f.num('TOPLAYERCRPCT', f.num('CRPCT', 50)) || 50;
        const fields: PadFields = {
          name: f.str('NAME'), layer: f.layer(), at: { x: f.len('X'), y: f.len('Y') }, w: size('TOP', 'TOPLAYER', 'X'), h: size('TOP', 'TOPLAYER', 'Y'), shape: shape('TOP'),
          hole: hole || undefined, rotation: f.num('ROTATION'), net: idx(f.idx('NET')), component: idx(f.idx('COMPONENT')), plated: f.has('PLATED') ? f.bool('PLATED') : undefined,
          cornerPct: pct, slot,
          ...(mode >= 1 ? { mid: { w: size('MID', 'MIDLAYER1', 'X'), h: size('MID', 'MIDLAYER1', 'Y'), shape: shape('MID') }, bot: { w: size('BOT', 'BOTTOMLAYER', 'X'), h: size('BOT', 'BOTTOMLAYER', 'Y'), shape: shape('BOT') } } : {}),
          solderExpansion: /^manual$/i.test(f.str('SOLDERMASKEXPANSIONMODE')) ? f.len('SOLDERMASKEXPANSION_MANUAL') : undefined,
          pasteExpansion: /^manual$/i.test(f.str('PASTEMASKEXPANSIONMODE')) ? f.len('PASTEMASKEXPANSION_MANUAL') : undefined,
        };
        const rec = encodePad(fields);
        const s = rec.subs[4]!;
        let fl = get(s, PAD.flags1) ?? 0;
        if (f.bool('TENTINGTOP')) fl |= FLAG.tentTop;
        if (f.bool('TENTINGBOTTOM')) fl |= FLAG.tentBottom;
        put(s, PAD.flags1, fl);
        lockFlags(s, PAD.flags1, f);
        if (f.has('PADJUMPERID')) put(s, PAD.jumperId, f.num('PADJUMPERID'));
        if (f.has('PLATED')) put(s, PAD.plated, f.bool('PLATED') ? 1 : 0);
        pads.push(rec);
        break;
      }
      case 'region': {
        // A board region (a part of the board on one layer stack): the board's, not a primitive
        if (/^boardregion$/i.test(f.str('OBJECTKIND'))) {
          boardRegions.push(regionRecord(f, bagOf(r.entries.filter(([k]) => !vertexKey(k) && !/^(MAINCONTOURVERTEXCOUNT|HOLECOUNT|INDEXFORSAVE)$/i.test(k))), false, true).rec);
          break;
        }
        const bag = bagOf(r.entries.filter(([k]) => !vertexKey(k)), PRIM_KEYS);
        const { rec, shapeBased } = regionRecord(f, bag, false);
        (shapeBased ? shapes : regions).push(rec);
        break;
      }
      case 'componentbody': {
        // A body's line repeats its outline after its model's keys: the first is the one
        const seen = new Set<string>();
        const own = r.entries.filter(([k]) => { const u = k.toUpperCase(); if (vertexKey(k) || seen.has(u)) return false; seen.add(u); return true; });
        bodies.push(regionRecord(f, bagOf(own, PRIM_KEYS), true).rec);
        break;
      }
    }
  }
  putBin('Pads6', pads); putBin('Tracks6', tracks); putBin('Vias6', vias); putBin('Fills6', fills); putBin('Arcs6', arcs); putBin('Texts6', texts);
  putBin('Regions6', regions); putBin('ShapeBasedRegions6', shapes); putBin('ComponentBodies6', bodies);
  if (boardRegions.length) putBin('BoardRegions', boardRegions);
  for (const st of ['Connections6', 'Coordinates6', 'EmbeddedBoards6', 'EmbeddedFonts6', 'Embeddeds6', 'FromTos6', 'Models', 'ModelsNoEmbed',
    'PadViaLibraryLinks', 'PinPairsSection', 'PrimitiveParameters', 'ShapeBasedComponentBodies6', 'SmartUnions', 'Textures', 'WaivedViolations', 'WideStrings6',
    'ExtendedPrimitiveInformation', 'UniqueIDPrimitiveInformation']) putBin(st, []);
  const doc = readPcbDoc(writeCfb(root), name);
  doc.dirty.add('Texts6');
  doc.ascii = true;
  doc.diags.info('ASCII PCB format');
  for (const n of notes) doc.diags.warn(n);
  return doc;
}

/* ───────────────────────────── writing ───────────────────────────── */

const LEN = (v: number) => formatAltiumLength(Math.round(v));
const TF = (b: boolean) => (b ? 'TRUE' : 'FALSE');

/** A record's line: RECORD= first, the entries, long records carried on after a bare CR where they say RECORD= again. */
function line(kind: string, entries: Entry[]): string {
  let s = `|RECORD=${kind}`;
  for (const [k, v] of entries) s += k.toUpperCase() === 'RECORD' ? `\r|RECORD=${v}` : `|${k}${v === null ? '' : `=${v}`}`;
  return s;
}

const entriesOf = (bag: PropertyBag | undefined): Entry[] => (bag ? bag.rawEntries().map((e) => [e.k, e.v ?? ''] as Entry) : []);

/** The vertex keys AD writes (KIND, VX, VY, CX, CY, SA, EA, R), the closing vertex (at the first, its own arc fields) too. */
function vertexEntries(verts: RegionVertex[], closing?: RegionVertex): Entry[] {
  const out: Entry[] = [];
  const all = verts.length ? [...verts, closing ? { ...closing, x: verts[0]!.x, y: verts[0]!.y } : { x: verts[0]!.x, y: verts[0]!.y }] : verts;
  all.forEach((v, i) => {
    const a = v.arc ?? v.rest;
    out.push([`KIND${i}`, v.arc ? '1' : '0'], [`VX${i}`, LEN(v.x)], [`VY${i}`, LEN(v.y)], [`CX${i}`, LEN(a?.cx ?? 0)], [`CY${i}`, LEN(a?.cy ?? 0)],
      [`SA${i}`, altiumFloat(a?.a1 ?? 0)], [`EA${i}`, altiumFloat(a?.a2 ?? 0)], [`R${i}`, LEN(a?.r ?? 0)]);
  });
  return out;
}

const common = (index: number, layer: LayerId, locked: boolean, keepout = false): Entry[] => [
  ['INDEXFORSAVE', String(index)], ['SELECTION', 'FALSE'], ['LAYER', layerToName(layer)], ['LOCKED', TF(locked)], ['POLYGONOUTLINE', 'FALSE'], ['USERROUTED', 'TRUE'],
  ['KEEPOUT', TF(keepout)], ['UNIONINDEX', '0'],
];
const owners = (p: { net?: number; component?: number; polygon?: number }): Entry[] => [
  ...(p.net !== undefined && p.net !== NO_NET ? [['NET', String(p.net)] as Entry] : []),
  ...(p.component !== undefined && p.component !== NO_NET ? [['COMPONENT', String(p.component)] as Entry] : []),
  ...(p.polygon !== undefined && p.polygon !== NO_NET ? [['POLYGON', String(p.polygon)] as Entry] : []),
];

/** A PcbDoc as AD's ASCII PCB file, and what it couldn't carry. */
export function writePcbAscii(edited: PcbDocument): { bytes: Uint8Array; warnings: string[] } {
  // The board as its binary file would be now (edits, wide strings, board regions written out)
  const doc = readPcbDoc(writePcbDoc(edited), edited.name);
  const lines: string[] = [];
  const warnings: string[] = [];
  const root = doc.cfb.root;
  lines.push(line('Board', entriesOf(doc.board.bag)));
  for (const o of OPTIONS) {
    const data = cfbStream(root, `${o}6/Data`);
    const bag = data ? splitTextRecords(data)[0] : undefined;
    if (bag) lines.push(line(o, entriesOf(bag)));
  }
  doc.classes.forEach((c, i) => lines.push(line('Class', [['INDEXFORSAVE', String(i)], ...entriesOf(c.bag)])));
  doc.nets.forEach((n, i) => lines.push(line('Net', [['ID', String(i)], ['INDEXFORSAVE', String(i)], ...entriesOf(n.bag)])));
  doc.components.forEach((c, i) => lines.push(line('Component', [['ID', String(i)], ['INDEXFORSAVE', String(i)], ...entriesOf(c.bag)])));
  doc.polygons.forEach((p, i) => lines.push(line('Polygon', [['ID', String(i)], ['INDEXFORSAVE', String(i)], ...entriesOf(p.bag)])));
  doc.rules.forEach((r, i) => lines.push(line('DXPRule', [['INDEXFORSAVE', String(i)], ...entriesOf(r.bag)])));
  doc.dimensions.forEach((d, i) => lines.push(line('Dimension', [['INDEXFORSAVE', String(i)], ...entriesOf(d.bag)])));
  (doc.diffPairs ?? []).forEach((b, i) => lines.push(line('DifferentialPair', [['INDEXFORSAVE', String(i)], ...entriesOf(b)])));
  // The board's regions (its layer stacks): regions of their own kind
  const br = cfbStream(root, 'BoardRegions/Data');
  if (br) splitBinaryRecords(br).forEach((r, i) => {
    if (!r.subs[0]) return;
    const parts = readRegionParts('Regions6', r.subs[0]);
    const own = entriesOf(parts.props);
    if (!own.some(([k]) => k.toUpperCase() === 'OBJECTKIND')) own.push(['OBJECTKIND', 'BoardRegion']);
    lines.push(line('Region', [['INDEXFORSAVE', String(i)], ...own, ['MAINCONTOURVERTEXCOUNT', String(parts.verts.length)], ...vertexEntries(parts.verts), ['HOLECOUNT', '0']]));
  });

  const prims = new Map<string, PcbPrim>(doc.prims.map((p) => [`${p.src.storage}:${p.src.index}`, p]));
  const n: Record<string, number> = {};
  const next = (k: string) => (n[k] = (n[k] ?? -1) + 1);
    const twins = new Set(doc.regionTwins?.values() ?? []);
  for (const storage of ['Arcs6', 'Pads6', 'Vias6', 'Tracks6', 'Texts6', 'Fills6', 'Regions6', 'ShapeBasedRegions6', 'ComponentBodies6']) {
    const s = doc.streams.get(storage);
    if (!s) continue;
    s.records.forEach((rec, i) => {
      const p = prims.get(`${storage}:${i}`);
      // A Regions6 region's twin: the region is written once
      if (!p && storage === 'ShapeBasedRegions6' && twins.has(rec)) return;
      if (!p) { warnings.push(`${storage}: a record Konium Designer couldn't read was left out`); return; }
      switch (p.kind) {
        case 'track': lines.push(line('Track', [...owners(p), ...common(next('Track'), p.layer, p.locked, p.keepout), ['SOLDERMASKEXPANSIONMODE', 'None'], ['PASTEMASKEXPANSIONMODE', 'None'],
          ['X1', LEN(p.a.x)], ['Y1', LEN(p.a.y)], ['X2', LEN(p.b.x)], ['Y2', LEN(p.b.y)], ['WIDTH', LEN(p.width)], ['SUBPOLYINDEX', String(get(rec.subs[0]!, TRACK.subpoly) ?? 0)]])); break;
        case 'arc': lines.push(line('Arc', [...owners(p), ...common(next('Arc'), p.layer, p.locked, p.keepout), ['SOLDERMASKEXPANSIONMODE', 'None'], ['PASTEMASKEXPANSIONMODE', 'None'],
          ['LOCATION.X', LEN(p.c.x)], ['LOCATION.Y', LEN(p.c.y)], ['RADIUS', LEN(p.r)], ['STARTANGLE', altiumFloat(p.start)], ['ENDANGLE', altiumFloat(p.end)], ['WIDTH', LEN(p.width)],
          ['SUBPOLYINDEX', String(get(rec.subs[0]!, ARC.subpoly) ?? 0)]])); break;
        case 'via': {
          const s0 = rec.subs[0]!, fl = get(s0, VIA.flags1) ?? 0;
          const maskMode = get(s0, VIA.maskMode) ?? 0;
          lines.push(line('Via', [...owners(p), ...common(next('Via'), L.MULTI, p.locked), ['X', LEN(p.at.x)], ['Y', LEN(p.at.y)], ['DIAMETER', LEN(p.diameter)], ['HOLESIZE', LEN(p.hole)],
            ['STARTLAYER', layerToName(p.layerStart)], ['ENDLAYER', layerToName(p.layerEnd)], ['PADMODE', '0'], ['TOPLAYERSIZE', LEN(p.diameter)], ['MIDLAYER1SIZE', LEN(p.diameter)], ['BOTTOMLAYERSIZE', LEN(p.diameter)],
            ['SOLDERMASKEXPANSIONMODE', maskMode === 2 ? 'Manual' : 'Rule'], ...(maskMode === 2 ? [['SOLDERMASKEXPANSION_MANUAL', LEN(get(s0, VIA.maskTop) ?? 0)] as Entry] : []),
            ['TENTINGTOP', TF((fl & FLAG.tentTop) !== 0)], ['TENTINGBOTTOM', TF((fl & FLAG.tentBottom) !== 0)]]));
          break;
        }
        case 'fill': lines.push(line('Fill', [...owners(p), ...common(next('Fill'), p.layer, p.locked, p.keepout), ['X1', LEN(p.a.x)], ['Y1', LEN(p.a.y)], ['X2', LEN(p.b.x)], ['Y2', LEN(p.b.y)],
          ['ROTATION', altiumFloat(p.rotation)]])); break;
        case 'text': {
          const kind = p.fontType === 2 ? 2 : p.fontType === 1 ? 1 : 0;
          const ascii = /^[\x20-\x7e]*$/.test(p.text);
          const comp = doc.components[p.component];
          // A designator says its component's; a .Designator special string stays one
          const raw = rec.subs[1] && rec.subs[1].length ? bytesToBin(rec.subs[1].subarray(1, 1 + rec.subs[1][0]!)) : '';
          const words = p.isDesignator && comp ? comp.designator : /^\.designator$/i.test(raw) ? raw : p.text;
          lines.push(line('Text', [...owners(p), ...common(next('Text'), p.layer, false), ['X', LEN(p.at.x)], ['Y', LEN(p.at.y)], ['HEIGHT', LEN(p.height)], ['FONT', 'DEFAULT'],
            ['ROTATION', altiumFloat(p.rotation)], ['MIRROR', TF(p.mirrored)], ['TEXT', (ascii ? words : words.replace(/[^\x20-\x7e]/g, '?')).replace(/\|/g, '!').replace(/\n/g, ' ')],
            ['WIDTH', LEN(p.strokeWidth)], ['USETTFONTS', TF(kind === 1)], ['BOLD', TF(p.bold)], ['ITALIC', TF(p.italic)], ['INVERTED', 'FALSE'], ['FONTNAME', p.fontName || 'Arial'],
            ['WIDESTRING', [...words].map((c) => c.codePointAt(0)!).join(',')], ['TEXTKIND', String(kind)],
            ...(p.isDesignator ? [['DESIGNATOR', 'True'] as Entry] : []), ...(p.isComment ? [['COMMENT', 'True'] as Entry] : [])]));
          break;
        }
        case 'pad': {
          const s4 = rec.subs[4]!, stack = rec.subs[5];
          const fl = get(s4, PAD.flags1) ?? 0;
          const solderMode = get(s4, PAD.solderMode) ?? 1, pasteMode = get(s4, PAD.pasteMode) ?? 1;
          const tmb = p.mid.w !== p.top.w || p.mid.h !== p.top.h || p.mid.shape !== p.top.shape || p.bot.w !== p.top.w || p.bot.h !== p.top.h || p.bot.shape !== p.top.shape;
          const shape = (x: typeof p.top) => SHAPE_OF[x.shape === 'roundrect' ? 'roundrect' : x.shape] ?? 'ROUND';
          const offsets: Entry[] = [];
          if (stack && stack.length >= PAD_STACK.minLen) for (let l = 0; l < 32; l++) offsets.push([`PADXOFFSET${l}`, LEN(get(stack, { off: PAD_STACK.offsetX + l * 4, t: 'i32' }) ?? 0)], [`PADYOFFSET${l}`, LEN(get(stack, { off: PAD_STACK.offsetY + l * 4, t: 'i32' }) ?? 0)]);
          lines.push(line('Pad', [...owners(p), ...common(next('Pad'), p.layer, p.locked),
            ['SOLDERMASKEXPANSIONMODE', solderMode === 2 ? 'Manual' : solderMode === 0 ? 'None' : 'Rule'], ['PASTEMASKEXPANSIONMODE', pasteMode === 2 ? 'Manual' : pasteMode === 0 ? 'None' : 'Rule'],
            ['NAME', p.name.replace(/\|/g, '!')], ['X', LEN(p.at.x)], ['Y', LEN(p.at.y)], ['XSIZE', LEN(p.top.w)], ['YSIZE', LEN(p.top.h)], ['SHAPE', shape(p.top)], ['HOLESIZE', LEN(p.hole)],
            ['ROTATION', altiumFloat(p.rotation)], ['PLATED', TF(p.plated)], ['DAISYCHAIN', ['Load', 'Terminator', 'Source'][get(s4, PAD.electrical) ?? 0] ?? 'Load'], ['PADMODE', tmb ? '1' : '0'],
            ...(tmb ? [['TOPXSIZE', LEN(p.top.w)], ['TOPYSIZE', LEN(p.top.h)], ['MIDXSIZE', LEN(p.mid.w)], ['MIDYSIZE', LEN(p.mid.h)], ['BOTXSIZE', LEN(p.bot.w)], ['BOTYSIZE', LEN(p.bot.h)],
              ['TOPSHAPE', shape(p.top)], ['MIDSHAPE', shape(p.mid)], ['BOTSHAPE', shape(p.bot)]] as Entry[] : []),
            ['TOPLAYERCRPCT', String(p.top.cornerPct)], ['MIDLAYER1CRPCT', String(p.mid.cornerPct)], ['BOTTOMLAYERCRPCT', String(p.bot.cornerPct)],
            ['DRILLTYPE', '0'], ['HOLETYPE', p.slot ? '2' : '0'], ['HOLEWIDTH', LEN(p.slot?.length ?? 0)], ['HOLEROTATION', altiumFloat(p.slot?.rotation ?? 0)], ...offsets,
            ['SOLDERMASKEXPANSION_MANUAL', LEN(get(s4, PAD.solderManual) ?? 0)], ['PASTEMASKEXPANSION_MANUAL', LEN(get(s4, PAD.pasteManual) ?? 0)],
            ['TENTINGTOP', TF((fl & FLAG.tentTop) !== 0)], ['TENTINGBOTTOM', TF((fl & FLAG.tentBottom) !== 0)], ['PADJUMPERID', String(p.jumper ?? 0)]]));
          break;
        }
        case 'region': case 'body': {
          // A shape-based region with a twin is written from the twin, arcs and all
          const twin = storage === 'Regions6' ? doc.regionTwins?.get(rec) : undefined;
          const from = twin && readRegionParts('Regions6', rec.subs[0]!).props.bool('ISSHAPEBASED') ? 'ShapeBasedRegions6' : storage === 'ShapeBasedRegions6' ? storage : 'Regions6';
          const parts = readRegionParts(from, (twin && from === 'ShapeBasedRegions6' && storage === 'Regions6' ? twin : rec).subs[0]!);
          // Which storage a region comes from goes by ISSHAPEBASED
          const own = entriesOf(parts.props).filter(([k]) => !['LAYER', 'LOCKED', 'KEEPOUT', 'SELECTION', 'POLYGONOUTLINE', 'USERROUTED', 'UNIONINDEX', 'INDEXFORSAVE'].includes(k.toUpperCase()))
            .map(([k, v]): Entry => (p.kind === 'region' && k.toUpperCase() === 'ISSHAPEBASED' ? [k, TF(from === 'ShapeBasedRegions6')] : [k, v]));
          if (p.kind === 'region' && !own.some(([k]) => k.toUpperCase() === 'ISSHAPEBASED')) own.push(['ISSHAPEBASED', TF(from === 'ShapeBasedRegions6')]);
          const holes: Entry[] = [['HOLECOUNT', String(parts.holes.length)]];
          parts.holes.forEach((h, k) => { holes.push([`HOLE${k}VERTEXCOUNT`, String(h.length)]); h.forEach((q, j) => holes.push([`H${k}VX${j}`, q.x.toFixed(4)], [`H${k}VY${j}`, q.y.toFixed(4)])); });
          const kind = p.kind === 'body' ? 'ComponentBody' : 'Region';
          const ownerOf = p.kind === 'body' ? { component: p.component } : { net: p.net, component: p.component, polygon: p.polygon };
          // (a teardrop keeps its mark [est: under the key tracks and arcs have it by])
          if (p.kind === 'region' && p.teardrop) own.unshift(['TEARDROP', 'TRUE']);
          lines.push(line(kind, [...owners(ownerOf), ...common(next(kind), p.layer, p.locked, p.kind === 'region' && p.keepout), ...own,
            ['MAINCONTOURVERTEXCOUNT', String(parts.verts.length)], ...vertexEntries(parts.verts, parts.closing), ...holes]));
          break;
        }
      }
    });
  }
  const models = cfbStream(root, 'Models/Header');
  if (models && models.length >= 4 && new DataView(models.buffer, models.byteOffset).getUint32(0, true) > 0) warnings.push('Embedded 3D models aren\'t carried in an ASCII PCB file: their bodies keep the model names');
  return { bytes: binToBytes(lines.join('\r\n') + '\r\n'), warnings };
}
