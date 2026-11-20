/**
 * R10, PADS boards both ways: a PADS Layout file read into Konium keeps its text (the PcbDoc's
 * PadsSource stream) with a fingerprint of the board the import made (Board6 PADSSIG). Written
 * back to PADS while the board is still that board, it is the file PADS wrote, every line as it
 * was; once changed, the export writes it from Konium's.
 */
import { PropertyBag } from '../altium/props';
import { boardSig, keepBoardSource, keptBoardSource, keepDesignSource, keptDesignSource, sheetSig } from '../keptSource';
import type { PcbRawRecord } from '../altium/framing';
import { primInfo, setPrimInfo } from '../altium/primInfo';
import { NO_NET, type PcbDocument, type PcbPrim } from '../../model/pcb';
import { footprintSig, recordSig } from '../kicad/kept';
import type { PadsBoard } from './layout';
import { keepJson } from '../kicad/padPrims';
import type { SchDocument } from '../../model/sch';

export const PADS_SOURCE = 'PadsSource';

/** Everything the board is (its primitives, parts, nets, pours, rules, classes, board settings but the import's keys): a fingerprint. */
export const padsBoardSig = (doc: PcbDocument): string => boardSig(doc, /^PADS/);

/** The PADS file a board was read from, kept in it, and its fingerprint. */
export const keepPadsSource = (doc: PcbDocument, text: Uint8Array): void => keepBoardSource(doc, text, PADS_SOURCE, 'PADSSIG', /^PADS/);

/** The PADS file a board was read from, while the board is still what the import made of it. */
export const keptPadsSource = (doc: PcbDocument): Uint8Array | null => keptBoardSource(doc, PADS_SOURCE, 'PADSSIG', /^PADS/);

/* ── a board changed in places (R10): its parts moved and its nets rerouted, the rest as PADS wrote it ── */

/**
 * A record the import made marked as the file's: R, a route's copper; I, the rest, with the object
 * it was made from when it is a free text, line item or pour (`obj`: T<n>, L<n>, P<n>, their places
 * in the file's lists). What Konium adds has no mark.
 */
export function tagPads(rec: PcbRawRecord, kind: 'R' | 'I', obj?: string): void {
  const others = (primInfo(rec)?.ExtendedPrimitiveInformation ?? []).filter((b) => b.get('TYPE') !== 'PADS');
  if ((primInfo(rec)?.ExtendedPrimitiveInformation ?? []).some((b) => b.get('TYPE') === 'PADS')) return;
  setPrimInfo(rec, 'ExtendedPrimitiveInformation', [...others, PropertyBag.fromEntries([['PRIMITIVEINDEX', '0'], ['PRIMITIVEOBJECTID', 'Track'], ['TYPE', 'PADS'], ['PADSK', kind], ...(obj ? [['PADSO', obj] as [string, string]] : [])])]);
}
const padsBag = (doc: PcbDocument, p: PcbPrim) => { const rec = doc.streams.get(p.src.storage)?.records[p.src.index]; return rec ? primInfo(rec)?.ExtendedPrimitiveInformation?.find((x) => x.get('TYPE') === 'PADS') : undefined; };
/** A primitive's mark: R, I, or none (Konium's own). */
export function padsMark(doc: PcbDocument, p: PcbPrim): string {
  return padsBag(doc, p)?.get('PADSK') ?? '';
}
/** The file's object a primitive was made from: T<n>, L<n>, P<n> (a free text, line item, pour), or none. */
export function padsObj(doc: PcbDocument, p: PcbPrim): string {
  return (padsBag(doc, p)?.get('PADSO') ?? '').replace(/\..*$/, '');
}
/** A line item's piece a primitive was made from (L<n>.<k>), or its object. */
export function padsPiece(doc: PcbDocument, p: PcbPrim): string {
  return padsBag(doc, p)?.get('PADSO') ?? '';
}
/** A pour's object: P<n> (the file's), or '+P' (Konium's own). */
export const pourKey = (doc: PcbDocument, i: number): string => { const n = doc.polygons[i]?.bag.get('PADSPOUR'); return n ? `P${n}` : '+P'; };
/**
 * What a primitive not in a part is on the way back: 'route' (its net's routes), its object (T<n>,
 * L<n>, P<n>; a pour's copper its pour's, '+P' a new pour's), '+' (Konium's own text, drawing,
 * keep-out or copper on no net: a new object), or 'rest' (the rest of the board).
 */
export function padsClass(doc: PcbDocument, p: PcbPrim): string {
  if ('polygon' in p && p.polygon !== NO_NET && p.polygon >= 0 && (p.kind === 'region' || p.kind === 'track' || p.kind === 'arc')) return pourKey(doc, p.polygon);
  const mark = padsMark(doc, p);
  if (isRouteCopper(p) && mark !== 'I') return 'route';
  const obj = padsObj(doc, p);
  if (obj) return obj;
  if (!mark && (p.kind === 'text' || p.kind === 'track' || p.kind === 'arc' || p.kind === 'fill' || (p.kind === 'region' && !p.boardCutout && p.regionKind !== 1))) return '+';
  return 'rest';
}
const inPart = (p: PcbPrim) => 'component' in p && p.component !== NO_NET && p.component >= 0;
const hash = (parts: string[]): string => {
  let h = 0x811c9dc5;
  for (const t of parts) { for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } h ^= 10; h = Math.imul(h, 0x01000193) >>> 0; }
  return `${h.toString(16)}:${parts.length}`;
};
const recOf = (doc: PcbDocument, p: PcbPrim) => doc.streams.get(p.src.storage)?.records[p.src.index];
const isRouteCopper = (p: PcbPrim) => (p.kind === 'track' || p.kind === 'arc' || p.kind === 'via') && (('component' in p ? p.component : NO_NET) === NO_NET) && p.net !== NO_NET && p.net >= 0 && !('polygon' in p && p.polygon !== NO_NET && p.polygon >= 0);

/** Each net's routes (the file's route copper, and what Konium added on the net) by net name: their fingerprints. */
export function padsRouteSigs(doc: PcbDocument): Map<string, string> {
  const by = new Map<string, string[]>();
  for (const p of doc.prims) {
    if (!isRouteCopper(p)) continue;
    const mark = padsMark(doc, p);
    if (mark === 'I') continue;
    const net = doc.nets[(p as { net: number }).net]?.name ?? '';
    const rec = recOf(doc, p);
    by.set(net, [...(by.get(net) ?? []), `${mark}${rec ? recordSig(rec) : ''}`]);
  }
  return new Map([...by].map(([n, l]) => [n, hash(l.sort())]));
}
/** All but the parts, the routes and the free texts', line items' and pours' objects: the board's other primitives, nets, rules, classes, settings. */
export function padsRestSig(doc: PcbDocument): string {
  const parts: string[] = [];
  for (const p of doc.prims) {
    if (inPart(p) || padsClass(doc, p) !== 'rest') continue;
    const rec = recOf(doc, p);
    parts.push(`${padsMark(doc, p)}${rec ? recordSig(rec) : p.kind}`);
  }
  parts.sort();
  const bag = (b: PropertyBag | undefined, skip?: RegExp) => { if (b) for (const k of b.keys()) if (!skip?.test(k)) parts.push(`${k}=${b.getRaw(k) ?? ''}`); };
  for (const x of doc.nets) parts.push(x.name);
  for (const r of doc.rules) bag(r.bag);
  for (const c of doc.classes) parts.push(`${c.name}:${c.members.join(',')}`);
  bag(doc.board.bag, /^PADS/);
  return hash(parts);
}
/** The file's free texts, line items and pours as Konium has them: each one's fingerprint (a pour's with its outline and settings). */
export function padsObjectSigs(doc: PcbDocument): Map<string, string> {
  const by = new Map<string, string[]>();
  const add = (k: string, s: string) => { const l = by.get(k); if (l) l.push(s); else by.set(k, [s]); };
  for (const p of doc.prims) {
    if (inPart(p)) continue;
    const k = padsClass(doc, p);
    if (!/^[TLP]\d/.test(k)) continue;
    const rec = recOf(doc, p);
    const sig = rec ? recordSig(rec) : p.kind;
    add(k, sig);
    // (a line item's pieces each, and the rest of it: L<n>.<k>, L<n>.)
    if (k.startsWith('L')) { const full = padsPiece(doc, p); add(full.includes('.') ? full : `${k}.`, sig); }
  }
  doc.polygons.forEach((pg, i) => {
    const k = pourKey(doc, i);
    if (k === '+P') return;
    for (const key of pg.bag.keys()) if (!/^PADS/.test(key)) add(k, `~${key}=${pg.bag.getRaw(key) ?? ''}`);
    add(k, `~${i}`);
  });
  return new Map([...by].map(([k, l]) => [k, hash(l.sort())]));
}

/** A part: its reference and its footprint as placed (where its own things are in it). */
export function padsPartSig(doc: PcbDocument, ci: number, prims: PcbPrim[]): string {
  const c = doc.components[ci]!;
  return `${footprintSig(doc, prims).items} ${c.designator}`;
}
/** Where a part is: its place, turn and side as its record holds them. */
export const padsPlace = (b: PropertyBag): string => ['X', 'Y', 'ROTATION', 'LAYER'].map((k) => b.get(k) ?? '').join(';');

/** The fingerprints the export compares with (the board as the import made it, read back). */
export function sealPads(doc: PcbDocument, src: PadsBoard): void {
  const byComp = new Map<number, PcbPrim[]>();
  for (const p of doc.prims) if ('component' in p && p.component !== NO_NET && p.component >= 0) byComp.set(p.component, [...(byComp.get(p.component) ?? []), p]);
  doc.components.forEach((c, ci) => {
    c.bag.set('PADSPART', padsPartSig(doc, ci, byComp.get(ci) ?? []));
    c.bag.set('PADSPLACE', padsPlace(c.bag));
  });
  doc.dirty.add('Components6');
  const routes = padsRouteSigs(doc);
  // (by the file's net names: those the import gave the nets)
  doc.board.bag?.set('PADSROUTES', keepJson(Object.fromEntries(routes)));
  doc.board.bag?.set('PADSREST', padsRestSig(doc));
  doc.board.bag?.set('PADSOBJS', keepJson(Object.fromEntries(padsObjectSigs(doc))));
  doc.board.bag?.set('PADSPARTS', String(doc.components.length));
  void src;
}

/* ── PADS Logic: a design read and written back unchanged ── */


/** A sheet's records (but the kept keys and unique IDs): a fingerprint. */
export const padsSheetSig = (doc: SchDocument): string => sheetSig(doc, /^PADS/);
/** Marks a PADS Logic design's sheets as it (its ID, each sheet's place and fingerprint), the file kept with the first. */
export const keepPadsLogic = (sheets: SchDocument[], source: Uint8Array): void => keepDesignSource(sheets, source, PADS_SOURCE, 'PADSLOGIC', 'PADSSHEETSIG', /^PADS/);
/** The PADS Logic file a set of sheets was read from, while they are all of it and as the import made them. */
export const keptPadsLogic = (sheets: SchDocument[]): Uint8Array | null => keptDesignSource(sheets, PADS_SOURCE, 'PADSLOGIC', 'PADSSHEETSIG', /^PADS/);
