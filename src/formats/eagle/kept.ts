/**
 * R13, EAGLE's files both ways: an EAGLE board (.brd) and schematic (.sch) read into Konium keep
 * their files (the PcbDoc's, the first SchDoc's EagleSource stream) with their names and
 * fingerprints of what the import made: the board as a whole (EAGLESIG), its parts each (EAGLEPART:
 * footprint, pads and their nets, its name and value; EAGLEPLACE: where it is), each signal's
 * routes (EAGLEROUTES) and the rest (EAGLEREST); each net its EAGLE signal's name (EAGLESIGNAL), the
 * board its EAGLE copper layers (EAGLELAYERS); each sheet its design's mark (EAGLESCH,
 * EAGLESHEETSIG). Exported for EAGLE while they are still what the import made of them, they are
 * the files EAGLE wrote, byte for byte; a board changed only by parts moved and nets rerouted is
 * EAGLE's file with those spliced in (splice.ts); otherwise the export writes them from Konium's.
 */
import { readPcbDoc, writePcbDoc } from '../altium/pcbdoc';
import { readSchDoc, writeSchDoc } from '../altium/schdoc';
import { keepBoardSource, keptBoardSource, keepDesignSource, keptDesignSource } from '../keptSource';
import { recordSig, localSig } from '../kicad/kept';
import { keepJson } from '../kicad/padPrims';
import { NO_NET, type PcbDocument, type PcbPrim } from '../../model/pcb';
import type { PropertyBag } from '../altium/props';
import type { SchDocument } from '../../model/sch';

export const EAGLE_SOURCE = 'EagleSource';
const SKIP = /^EAGLE/;
const headerOf = (doc: SchDocument) => doc.records.find((r) => r.bag?.int('RECORD', -1) === 31)?.bag;
const hash = (parts: string[]): string => {
  let h = 0x811c9dc5;
  for (const t of parts) { for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } h ^= 10; h = Math.imul(h, 0x01000193) >>> 0; }
  return `${h.toString(16)}:${parts.length}`;
};
const inPart = (p: PcbPrim) => 'component' in p && p.component !== NO_NET && p.component >= 0;
const recOf = (doc: PcbDocument, p: PcbPrim) => doc.streams.get(p.src.storage)?.records[p.src.index];
/** A signal's routed copper: its tracks, arcs and vias (not a pour's, not a part's). */
export const isRouteCopper = (p: PcbPrim): boolean => (p.kind === 'track' || p.kind === 'arc' || p.kind === 'via') && !inPart(p) && p.net !== NO_NET && p.net >= 0
  && !('keepout' in p && p.keepout) && !('polygon' in p && p.polygon !== NO_NET && p.polygon >= 0);
const pourCopper = (doc: PcbDocument, p: PcbPrim) => 'polygon' in p && p.polygon !== NO_NET && p.polygon >= 0 && p.polygon < doc.polygons.length;

/** Each net's routes by its EAGLE signal's name: their fingerprints. */
export function eagleRouteSigs(doc: PcbDocument): Map<string, string> {
  const by = new Map<string, string[]>();
  for (const p of doc.prims) {
    if (!isRouteCopper(p)) continue;
    const n = doc.nets[(p as { net: number }).net];
    const k = n?.bag.get('EAGLESIGNAL') ?? n?.name ?? '';
    const rec = recOf(doc, p);
    by.set(k, [...(by.get(k) ?? []), rec ? recordSig(rec) : p.kind]);
  }
  return new Map([...by].map(([n, l]) => [n, hash(l.sort())]));
}
/** All but the parts, the routes and the pours' copper (EAGLE pours its own): the board's other primitives, pours, nets, rules, classes, settings. */
export function eagleRestSig(doc: PcbDocument): string {
  const parts: string[] = [];
  for (const p of doc.prims) {
    if (inPart(p) || isRouteCopper(p) || pourCopper(doc, p)) continue;
    const rec = recOf(doc, p);
    parts.push(rec ? recordSig(rec) : p.kind);
  }
  parts.sort();
  const bag = (b: PropertyBag | undefined, skip?: RegExp) => { if (b) for (const k of b.keys()) if (!skip?.test(k)) parts.push(`${k}=${b.getRaw(k) ?? ''}`); };
  for (const x of doc.nets) parts.push(`${x.name}:${x.bag.get('EAGLESIGNAL') ?? ''}`);
  for (const pg of doc.polygons) bag(pg.bag);
  for (const r of doc.rules) bag(r.bag);
  for (const c of doc.classes) parts.push(`${c.name}:${c.members.join(',')}`);
  bag(doc.board.bag, SKIP);
  return hash(parts);
}
/** A part: its name, value, footprint as placed and its pads with their nets (where each is in it). */
export function eaglePartSig(doc: PcbDocument, ci: number, prims: PcbPrim[]): string {
  const c = doc.components[ci]!;
  const r = (-c.rotation * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  const g = (v: number) => Math.round(v / 20);
  const rel = (q: { x: number; y: number }) => { const dx = q.x - c.at.x, dy = q.y - c.at.y; return `${g(dx * cos - dy * sin)},${g(dx * sin + dy * cos)}`; };
  const sigs = prims.map((p) => (p.kind === 'pad' ? `p ${p.name} ${p.layer} ${rel(p.at)} ${Math.round((((p.rotation - c.rotation) % 360) + 360) % 360)} ${g(p.top.w)} ${g(p.top.h)} ${p.top.shape} ${g(p.hole)} ${doc.nets[p.net]?.name ?? ''}`
    : localSig(doc, p) ?? p.kind)).sort();
  return `${hash(sigs)} ${c.designator} ${c.layer} ${c.bag.get('PATTERN') ?? ''}`;
}
/** Where a part is: its place, turn and side as its record holds them. */
export const eaglePlace = (b: PropertyBag): string => ['X', 'Y', 'ROTATION', 'LAYER'].map((k) => b.get(k) ?? '').join(';');

/** The fingerprints the export compares with (the board as the import made it, read back). */
function sealEagle(doc: PcbDocument): void {
  const byComp = new Map<number, PcbPrim[]>();
  for (const p of doc.prims) if (inPart(p)) byComp.set((p as { component: number }).component, [...(byComp.get((p as { component: number }).component) ?? []), p]);
  doc.components.forEach((c, ci) => {
    c.bag.set('EAGLEPART', eaglePartSig(doc, ci, byComp.get(ci) ?? []));
    c.bag.set('EAGLEPLACE', eaglePlace(c.bag));
  });
  doc.dirty.add('Components6');
  doc.board.bag?.set('EAGLEROUTES', keepJson(Object.fromEntries(eagleRouteSigs(doc))));
  doc.board.bag?.set('EAGLEREST', eagleRestSig(doc));
  doc.board.bag?.set('EAGLEPARTS', String(doc.components.length));
}

/**
 * A board converted from an EAGLE file, with that file kept in it: each net named by its signal
 * (`signals`, by the board's net index), the copper layers EAGLE numbered (`layers`: AD layer →
 * EAGLE's number).
 */
export function keepBrd(pcb: Uint8Array, docName: string, src: Uint8Array, fileName: string, signals: string[], layers: Map<number, number>): Uint8Array {
  let doc = readPcbDoc(pcb, docName);
  doc.nets.forEach((n, i) => { if (signals[i]) n.bag.set('EAGLESIGNAL', signals[i]!); });
  doc.dirty.add('Nets6');
  doc.board.bag?.set('EAGLEFILE', fileName.replace(/^.*[\\/]/, ''));
  doc.board.bag?.set('EAGLELAYERS', [...layers].map(([l, n]) => `${l}:${n}`).join(','));
  doc.dirty.add('Board6');
  // Sealed as it reads back (the fingerprints taken from what a later read sees)
  doc = readPcbDoc(writePcbDoc(doc), docName);
  sealEagle(doc);
  keepBoardSource(doc, src, EAGLE_SOURCE, 'EAGLESIG', SKIP);
  return writePcbDoc(doc);
}

/** The EAGLE file a board was read from (and its name), while the board is still what the import made of it. */
export function keptBrd(doc: PcbDocument): { file: string; bytes: Uint8Array } | null {
  const bytes = keptBoardSource(doc, EAGLE_SOURCE, 'EAGLESIG', SKIP);
  const file = doc.board.bag?.get('EAGLEFILE');
  return bytes && file ? { file, bytes } : null;
}

/** A schematic's sheets converted from an EAGLE file, the file kept with the first. */
export function keepSch(sheets: { name: string; bytes: Uint8Array }[], src: Uint8Array, fileName: string): { name: string; bytes: Uint8Array }[] {
  if (!sheets.length) return sheets;
  const docs = sheets.map((s) => readSchDoc(s.bytes, s.name));
  headerOf(docs[0]!)?.set('EAGLEFILE', fileName.replace(/^.*[\\/]/, ''));
  keepDesignSource(docs, src, EAGLE_SOURCE, 'EAGLESCH', 'EAGLESHEETSIG', SKIP);
  return sheets.map((s, i) => ({ name: s.name, bytes: writeSchDoc(docs[i]!) }));
}

/** The EAGLE file a set of sheets was read from (and its name), while they are all of it and as the import made them. */
export function keptSch(sheets: SchDocument[]): { file: string; bytes: Uint8Array } | null {
  const bytes = keptDesignSource(sheets, EAGLE_SOURCE, 'EAGLESCH', 'EAGLESHEETSIG', SKIP);
  if (!bytes) return null;
  const first = sheets.find((d) => /^\S+ 0 /.test(headerOf(d)?.get('EAGLESCH') ?? ''));
  const file = first ? headerOf(first)?.get('EAGLEFILE') : undefined;
  return file ? { file, bytes } : null;
}
