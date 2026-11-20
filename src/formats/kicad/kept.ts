/**
 * KiCad board graphics and texts kept whole for the way back (R9). What the import makes of a
 * gr_line, gr_rect, gr_circle, gr_arc, gr_poly, gr_curve or gr_text (tracks, arcs, regions, a
 * text per line) carries the KiCad object in the board's per-primitive records
 * (ExtendedPrimitiveInformation, TYPE=KiCad: KICADGROUP, KICADN how many it made, KICADSIG each
 * one's fingerprint, KICADSRC the object on the first). The export writes the object again while
 * all it made are there and unchanged (a Bezier curve stays a curve, a rectangle a rectangle, a
 * text of several lines one text with KiCad's anchor and size); else what Konium has.
 */
import type { PcbRawRecord } from '../altium/framing';
import { PCB_TAG, countHeader, joinTextRecords, splitTextRecords } from '../altium/framing';
import { cfbPut, cfbStream, type CfbEntry } from '../cfb/cfb';
import { PropertyBag } from '../altium/props';
import { primInfo, setPrimInfo } from '../altium/primInfo';
import { TEXT } from '../altium/pcbLayouts';
import { NO_NET, type PcbDocument, type PcbPrim } from '../../model/pcb';
import { Bare, L, bare, isList, type SList, type WNode } from './sexpr';
import { keepJson, readJson } from './padPrims';

/** A record's fingerprint: its bytes (a text's wide-string number left out, set on saving). */
/**
 * A library symbol's records as Konium has them (their settings but their unique IDs and the kept
 * KiCad symbol itself): while they are what the import made, KiCad's symbol is the symbol.
 */
export function bagsSig(bags: readonly PropertyBag[]): string {
  let h = 0x811c9dc5, n = 0;
  for (const b of bags) {
    for (const k of b.keys()) {
      if (k === 'UNIQUEID' || k === 'KICADSRC' || k === 'KICADSIG') continue;
      const t = `${k}=${b.getRaw(k) ?? ''}|`;
      for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
      n++;
    }
    h ^= 10; h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}:${bags.length}:${n}`;
}

/**
 * A library footprint's primitives as Konium has them (where each is, to half a mil): while they
 * are what the import made, KiCad's footprint is the footprint.
 */
export function libFootprintSig(prims: readonly PcbPrim[]): string {
  const g = (v: number) => Math.round(v / 20);
  const pt = (q: { x: number; y: number }) => `${g(q.x)},${g(q.y)}`;
  const sigs = prims.map((p) => {
    switch (p.kind) {
      case 'track': return `t ${p.layer} ${[pt(p.a), pt(p.b)].sort().join(' ')} ${g(p.width)}`;
      case 'arc': return `a ${p.layer} ${pt(p.c)} ${g(p.r)} ${Math.round(p.start)} ${Math.round(p.end)} ${g(p.width)}`;
      case 'pad': return `p ${p.name} ${p.layer} ${pt(p.at)} ${Math.round(p.rotation)} ${g(p.top.w)} ${g(p.top.h)} ${p.top.shape} ${g(p.hole)}`;
      case 'via': return `v ${pt(p.at)} ${g(p.diameter)} ${g(p.hole)}`;
      case 'text': return `x ${p.layer} ${pt(p.at)} ${Math.round(p.rotation)} ${g(p.height)} ${p.text}`;
      case 'region': return `r ${p.layer} ${p.outline.length} ${p.outline[0] ? pt(p.outline[0]) : ''} ${p.holes.length}`;
      case 'fill': return `f ${p.layer} ${[pt(p.a), pt(p.b)].sort().join(' ')}`;
      default: return p.kind;
    }
  }).sort();
  let h = 0x811c9dc5;
  for (const t of sigs) { for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } h ^= 10; h = Math.imul(h, 0x01000193) >>> 0; }
  return `${h.toString(16)}:${sigs.length}`;
}

/**
 * A placed part's symbol as Konium has it, its placement undone (makeLib's symbolOf): its pins and
 * drawing (not its fields, parameters or models: the library symbol's are its library's), while
 * they are what the import made, KiCad's library symbol is its symbol.
 */
export function partSymbolSig(bags: readonly PropertyBag[]): string {
  const FIELDS = new Set(['0', '1', '31', '34', '41', '44', '45', '46', '47', '48']);
  return bagsSig(bags.filter((b) => !FIELDS.has(b.get('RECORD') ?? '0')));
}
/** The library symbols a schematic's parts were placed from, kept from KiCad (one copy each, by key): the schematic's store. */
export const KEPT_SYMBOLS = 'KiCadSymbols';
const symStores = new WeakMap<object, Map<string, string>>();
export function symbolStore(root: CfbEntry): Map<string, string> {
  let m = symStores.get(root);
  if (!m) {
    m = new Map();
    const data = cfbStream(root, `${KEPT_SYMBOLS}/Data`);
    if (data) for (const b of splitTextRecords(data)) { const k = b.get('KEY'); if (k) m.set(k, b.getRaw('ITEMS') ?? ''); }
    symStores.set(root, m);
  }
  return m;
}

/** A polygon pour's outline as its record holds it (its vertices' keys), to tell whether it is still what the import made. */
export function vertexSig(b: PropertyBag): string {
  let h = 0x811c9dc5, n = 0;
  for (const k of b.keys()) {
    if (!/^(KIND|VX|VY|CX|CY|SA|EA|R)\d+$/i.test(k)) continue;
    const t = `${k}=${b.getRaw(k) ?? ''};`;
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    n++;
  }
  return `${h.toString(16)}:${n}`;
}

export function recordSig(rec: PcbRawRecord): string {
  let h = 0x811c9dc5;
  rec.subs.forEach((s, k) => {
    for (let i = 0; i < s.length; i++) {
      const wide = rec.tag === PCB_TAG.TEXT && k === 0 && i >= TEXT.wideIndex.off && i < TEXT.wideIndex.off + 4;
      h ^= wide ? 0 : s[i]!;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= 0x2c; h = Math.imul(h, 0x01000193) >>> 0;
  });
  return h.toString(16).padStart(8, '0');
}

/** The records one KiCad object made, given that object: each told so (its fingerprint taken later, by sealKept). */
export function keepWhole(made: PcbRawRecord[], g: SList, id: string): void {
  made.forEach((rec, k) => {
    const others = (primInfo(rec)?.ExtendedPrimitiveInformation ?? []).filter((b) => b.get('TYPE') !== 'KiCad');
    const kv: [string, string][] = [['PRIMITIVEINDEX', '0'], ['PRIMITIVEOBJECTID', 'Track'], ['TYPE', 'KiCad'], ['KICADGROUP', id], ['KICADN', String(made.length)]];
    if (k === 0) kv.push(['KICADSRC', keepJson(g)]);
    setPrimInfo(rec, 'ExtendedPrimitiveInformation', [...others, PropertyBag.fromEntries(kv)]);
  });
}

/**
 * A track's, arc's or via's KiCad uuid, kept where a group or generated object names it (KICADUUID;
 * its fingerprint taken by sealKept, to tell a tuning pattern's tracks unchanged).
 */
export function keepId(rec: PcbRawRecord, id: string, extras?: string): void {
  const others = (primInfo(rec)?.ExtendedPrimitiveInformation ?? []).filter((b) => b.get('TYPE') !== 'KiCad');
  const kv: [string, string][] = [['PRIMITIVEINDEX', '0'], ['PRIMITIVEOBJECTID', 'Track'], ['TYPE', 'KiCad']];
  if (id) kv.push(['KICADUUID', id]);
  // (and a via's settings Konium makes nothing of: extrasOf)
  if (extras) kv.push(['KICADX', extras]);
  setPrimInfo(rec, 'ExtendedPrimitiveInformation', [...others, PropertyBag.fromEntries(kv)]);
}
/** A primitive's kept KiCad uuid (or none), whether it is still what the import made, and the settings kept with it. */
export function keptId(doc: PcbDocument, p: PcbPrim): { id: string; same: boolean; extras: SList[] | null } | null {
  const rec = doc.streams.get(p.src.storage)?.records[p.src.index];
  const b = rec && primInfo(rec)?.ExtendedPrimitiveInformation?.find((x) => x.get('TYPE') === 'KiCad' && !x.has('KICADGROUP'));
  if (!b) return null;
  return { id: b.get('KICADUUID') ?? '', same: b.get('KICADSIG') === recordSig(rec!), extras: b.has('KICADX') ? readJson<SList[]>(b.getRaw('KICADX')) : null };
}

/** Each kept record's fingerprint, once its bytes are final (after the board is put together). */
export function sealKept(recs: PcbRawRecord[]): void {
  for (const rec of recs) {
    const list = primInfo(rec)?.ExtendedPrimitiveInformation;
    const b = list?.find((x) => x.get('TYPE') === 'KiCad');
    if (b && !b.has('KICADSIG')) b.set('KICADSIG', recordSig(rec));
  }
}

/**
 * A part's item as it sits in the part: its shape about the part's place, its own turn less the
 * part's (to 2 µm and a hundredth of a degree), so moving or turning the part changes nothing.
 */
export function localSig(doc: PcbDocument, p: PcbPrim): string | null {
  const c = 'component' in p ? doc.components[p.component] : undefined;
  if (!c) return null;
  const r = (-c.rotation * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  const g = (v: number) => Math.round(v / 20);
  const rel = (q: { x: number; y: number }) => { const dx = q.x - c.at.x, dy = q.y - c.at.y; return `${g(dx * cos - dy * sin)},${g(dx * sin + dy * cos)}`; };
  const turn = (a: number) => (Math.round((((a - c.rotation) % 360) + 360) % 360 * 100) / 100) % 360;
  switch (p.kind) {
    case 'track': return `t ${p.layer} ${[rel(p.a), rel(p.b)].sort().join(' ')} ${g(p.width)}`;
    case 'arc': return `a ${p.layer} ${rel(p.c)} ${g(p.r)} ${turn(p.start)} ${turn(p.end)} ${g(p.width)}`;
    case 'text': return `x ${p.layer} ${rel(p.at)} ${turn(p.rotation)} ${g(p.height)} ${p.mirrored ? 1 : 0} ${p.text}`;
    case 'region': return `r ${p.layer} ${p.outline.length} ${p.outline[0] ? rel(p.outline[0]) : ''} ${p.holes.length}`;
    case 'fill': return `f ${p.layer} ${[rel(p.a), rel(p.b)].sort().join(' ')}`;
    default: return null;
  }
}

/** The board's storage for footprints' kept items (a record each: KEY, ITEMS), which Konium keeps as it is. */
export const KEPT_STORAGE = 'KiCadKept6';
/** The footprints' kept items into the board's file (a record each: Board6 holds no more than 16 MB). */
export function writeFootprintStore(doc: PcbDocument, store: Map<string, string>): void {
  if (!store.size) return;
  const bags = [...store].map(([k, v]) => PropertyBag.fromEntries([['KEY', k], ['ITEMS', v]]));
  cfbPut(doc.cfb.root, `${KEPT_STORAGE}/Data`, joinTextRecords(bags));
  cfbPut(doc.cfb.root, `${KEPT_STORAGE}/Header`, countHeader(bags.length));
}
const stores = new WeakMap<object, Map<string, string>>();
/** The footprints' kept items by key, read once. */
export function footprintStore(doc: PcbDocument): Map<string, string> {
  let m = stores.get(doc.cfb.root);
  if (!m) {
    m = new Map();
    const data = cfbStream(doc.cfb.root, `${KEPT_STORAGE}/Data`);
    if (data) for (const b of splitTextRecords(data)) { const k = b.get('KEY'); if (k) m.set(k, b.getRaw('ITEMS') ?? ''); }
    stores.set(doc.cfb.root, m);
  }
  return m;
}

/**
 * A footprint's own graphics and texts (all but its pads and its Reference and Value) kept whole on
 * its component: the items, once in the board's file for every footprint with the same ones (KEPT_STORAGE),
 * the component naming them (KICADFPKEY); its Reference and Value as KiCad had them (KICADFIELDS).
 * Its fingerprint (KICADFPSIG: where its own things are in the part) is taken by sealFootprints.
 */
export function keepFootprint(comp: PropertyBag, items: SList[], fields: Record<string, SList | undefined>, store: Map<string, string>): void {
  if (items.length) {
    const json = keepJson(items);
    let h = 0x811c9dc5;
    for (let i = 0; i < json.length; i++) { h ^= json.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    const key = `${h.toString(16).padStart(8, '0')}${json.length.toString(16)}`;
    store.set(key, json);
    comp.set('KICADFPKEY', key);
  }
  const f = Object.fromEntries(Object.entries(fields).filter((e): e is [string, SList] => !!e[1]));
  if (Object.keys(f).length) comp.set('KICADFIELDS', keepJson(f));
}

/** Of a component's primitives, its own graphics and texts as the footprint's items made them (not its pads' shapes or its fields). */
export function ownItems(prims: PcbPrim[]): PcbPrim[] {
  return prims.filter((p) => !('keepout' in p && p.keepout) && (
    p.kind === 'track' || p.kind === 'arc' || p.kind === 'fill' || (p.kind === 'text' && !p.isDesignator && !p.isComment)
    || (p.kind === 'region' && p.padShape === undefined && !p.kicadAperture && !p.kicadPrim)));
}
/** Where a component's own things are in it, from its primitives: its items', its designator's and comment's. */
export function footprintSig(doc: PcbDocument, prims: PcbPrim[]): { items: string; ref: string; val: string } {
  const sigs = ownItems(prims).map((p) => localSig(doc, p) ?? '').sort();
  let h = 0x811c9dc5;
  for (const t of sigs) { for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } h ^= 10; h = Math.imul(h, 0x01000193) >>> 0; }
  const field = (k: 'isDesignator' | 'isComment') => { const t = prims.find((p) => p.kind === 'text' && p[k]); return t ? localSig(doc, t) ?? '' : ''; };
  return { items: `${h.toString(16)}:${sigs.length}`, ref: field('isDesignator'), val: field('isComment') };
}
/** Each footprint's fingerprint, once the board's parts are placed (Components6 marked to be written). */
export function sealFootprints(doc: PcbDocument): void {
  const by = new Map<number, PcbPrim[]>();
  for (const p of doc.prims) if ('component' in p && p.component !== NO_NET) { const l = by.get(p.component); if (l) l.push(p); else by.set(p.component, [p]); }
  let any = false;
  doc.components.forEach((c, ci) => {
    if (!c.bag.has('KICADFPKEY') && !c.bag.has('KICADFIELDS')) return;
    const s = footprintSig(doc, by.get(ci) ?? []);
    c.bag.set('KICADFPSIG', s.items); c.bag.set('KICADREFSIG', s.ref); c.bag.set('KICADVALSIG', s.val);
    any = true;
  });
  if (any) doc.dirty.add('Components6');
}

export interface Kept { group: string; n: number; src?: SList; same: boolean }
/** What a primitive keeps of KiCad, and whether it is still what the import made. */
export function keptOf(doc: PcbDocument, p: PcbPrim): Kept | null {
  const rec = doc.streams.get(p.src.storage)?.records[p.src.index];
  if (!rec) return null;
  const b = primInfo(rec)?.ExtendedPrimitiveInformation?.find((x) => x.get('TYPE') === 'KiCad');
  if (!b || !b.has('KICADGROUP')) return null;
  const src = b.has('KICADSRC') ? readJson<SList>(b.get('KICADSRC')) ?? undefined : undefined;
  const same = b.get('KICADSIG') === recordSig(rec);
  return { group: b.get('KICADGROUP') ?? '', n: b.int('KICADN', 1), ...(src ? { src } : {}), same };
}

/**
 * An object's settings the import makes nothing of, for the way back: its lists but those `used`
 * (and its uuid), a field (property) but those named in `used` as "property Name", and its bare
 * words after the first `atoms` (blind, locked) as lists of no keyword.
 */
export function extrasOf(n: SList, used: ReadonlySet<string>, atoms = 0): SList[] {
  const out: SList[] = [];
  n.items.forEach((x, i) => {
    if (isList(x)) {
      if (x.k === 'uuid' || x.k === 'tstamp' || used.has(x.k) || (x.k === 'property' && used.has(`property ${String(x.items[0] ?? '')}`))) return;
      out.push(x);
    } else if (i >= atoms && typeof x === 'string') out.push({ k: '', items: [x] });
  });
  return out;
}
/** What a pour's settings in Konium are, to tell whether KiCad's zone settings kept with it still hold. */
export const zoneSig = (b: PropertyBag): string => {
  let h = 0x811c9dc5;
  for (const c of ['NAME', 'HATCHSTYLE', 'TRACKWIDTH', 'GRIDSIZE', 'REMOVEDEAD', 'POURINDEX', 'LAYER', 'POUROVER', 'ARCAPPROXIMATION', 'MINPRIMLENGTH'].map((k) => b.get(k) ?? '').join('\n')) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
};
/** A list's key among its fellows: a field by its name. */
const keyOf = (k: string, first: unknown) => (k === 'property' ? `property ${String(first ?? '')}` : k);
/**
 * A list written with the settings kept for it that the writer didn't write itself (a keyword, a
 * field, a bare word once each); places moved as the board is.
 */
export function withExtras(node: WNode, extras: SList[] | null | undefined, move?: (x: number, y: number) => [number, number]): WNode {
  if (!extras?.length) return node;
  const have = new Set<string>(), words = new Set<string>();
  for (const x of node.items) {
    if (x instanceof Bare) words.add(x.s);
    else if (typeof x === 'object' && 'k' in x) have.add(keyOf(x.k, x.items[0] instanceof Bare ? x.items[0].s : x.items[0]));
  }
  const add: WNode['items'] = [], front: Bare[] = [];
  for (const e of extras) {
    if (e.k === '') { const w = String(e.items[0] ?? ''); if (w && !words.has(w)) { words.add(w); front.push(bare(w)); } continue; }
    const key = keyOf(e.k, e.items[0]);
    if (have.has(key)) continue;
    have.add(key);
    add.push(toWNode(e, undefined, move));
  }
  // (bare words straight after the keyword's first word, if it has one, as KiCad writes them)
  const lead = node.items.length && !(typeof node.items[0] === 'object' && !(node.items[0] instanceof Bare)) ? 1 : 0;
  // (a uuid stays last)
  const uuidAt = node.items.findIndex((x) => typeof x === 'object' && !(x instanceof Bare) && 'k' in x && x.k === 'uuid');
  const items = [...node.items];
  if (uuidAt >= 0) items.splice(uuidAt, 0, ...add); else items.push(...add);
  items.splice(lead, 0, ...front);
  return { k: node.k, items };
}

/** A list written with the kept lists of these keywords in place of its own (KiCad's settings where Konium's are its approximation). */
export function preferKept(node: WNode, kept: SList[] | null | undefined, keys: ReadonlySet<string>, move?: (x: number, y: number) => [number, number]): WNode {
  if (!kept?.length) return node;
  const items = node.items.map((x) => {
    if (typeof x !== 'object' || x instanceof Bare || !('k' in x) || !keys.has(x.k)) return x;
    const k = kept.find((y) => y.k === x.k);
    return k ? toWNode(k, undefined, move) : x;
  });
  return { k: node.k, items };
}

/** Lists whose atoms KiCad writes in quotes (the rest are its keywords, bare). */
const QUOTED: Record<string, (i: number) => boolean> = {
  gr_text: (i) => i === 0, fp_text: (i) => i === 1, property: (i) => i < 2, layer: (i) => i === 0, layers: () => true, face: () => true, net_name: () => true, uuid: () => true, tstamp: () => true,
  // A dimension's format, the title block's fields
  prefix: () => true, suffix: () => true, override_value: () => true, title: () => true, date: () => true, rev: () => true, company: () => true, comment: (i) => i === 1,
  // A group's members (uuids), a group's name
  members: () => true, group: (i) => i === 0,
  // A pad's pin and footprint's settings kept (their words)
  pinfunction: () => true, pintype: () => true, tags: () => true, sheetname: () => true, sheetfile: () => true, descr: () => true, zone_layer_connections: () => true,
  model: (i) => i === 0, class: () => true, pins: () => true, name: () => true, checksum: () => true,
  // A library's symbols and footprints kept whole: their names, pins' numbers, texts, paths and ids
  footprint: (i) => i === 0, pad: (i) => i === 0, symbol: (i) => i === 0, extends: () => true, number: (i) => i === 0, text: (i) => i === 0, text_box: (i) => i === 0,
  generator: () => true, generator_version: () => true, net: (i) => i === 1, member: (i) => i === 0, path: () => true, lib_id: () => true, lib_name: () => true, reference: () => true, data: () => true,
};
/** A generated object's (a tuning pattern's) settings KiCad writes bare: its type, and yes and no. */
const GEN_BARE = new Set(['type']);
/** Lists whose first two numbers are a place on the board. */
const PLACES = new Set(['start', 'end', 'center', 'mid', 'at', 'xy']);
/**
 * A list read from the file, to write again: its uuid given anew, its places moved as the rest of
 * the board is (the export centres the board on its page).
 */
export function toWNode(n: SList, uuid?: string, move?: (x: number, y: number) => [number, number]): WNode {
  const quoted = QUOTED[n.k];
  // A generated object's settings: its words quoted (a side, a net, a mode), but for its type and yes and no
  const gen = n.k === 'generated';
  const items = n.items.map((x, i) => (isList(x)
    ? gen && !GEN_BARE.has(x.k) && !x.items.some(isList) ? L(x.k, ...x.items.map((a) => (typeof a === 'string' && !/^(yes|no)$/.test(a) ? a : typeof a === 'string' ? bare(a) : a))) : toWNode(x, undefined, move)
    // (a word that reads as a number was a string: KiCad's numbers are read as numbers)
    : typeof x === 'number' ? x : quoted?.(i) || /^[-+]?\.?\d/.test(x) ? x : /[\s()"]/.test(x) || x === '' ? x : bare(x)));
  if (move && PLACES.has(n.k) && typeof items[0] === 'number' && typeof items[1] === 'number') [items[0], items[1]] = move(items[0], items[1]);
  return L(n.k, ...items, uuid ? L('uuid', uuid) : null);
}
