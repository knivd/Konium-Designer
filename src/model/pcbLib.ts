/**
 * A PCB library open for editing: each footprint is presented to the PCB editor as a small
 * PcbDocument (origin at the footprint origin, no board), so placing, routing, moving and DRC
 * all work the same as on a board.
 *
 * Saving rewrites only what changed: an edited footprint gets new Data / Header / Parameters
 * streams in its own storage; untouched footprints, 3D models and every other stream in the
 * library are written back byte for byte. Library/Data keeps its property block and gets the
 * new footprint list.
 */
import { cfbFind, cfbPut, cloneCfb, newEntry, writeCfb, type CfbEntry } from '../formats/cfb/cfb';
import { BinReader, BinWriter } from '../formats/bin';
import { PCB_TAG, countHeader, joinBinaryRecords, type PcbRawRecord } from '../formats/altium/framing';
import { newLibraryRecord, isThinRecord } from '../formats/altium/board6';
import { PropertyBag } from '../formats/altium/props';
import { placeRecord, readPcbLib, storageFor, writePcbLib, type Footprint, type FootprintDef, type PcbLibrary } from '../formats/altium/pcblib';
import { placement, transformRecord } from '../formats/altium/pcbTransform';
import { PRIM_STORAGES, rebuildPrims } from '../formats/altium/pcbdoc';
import { defaultRules } from '../formats/altium/rules';
import { binToBytes } from '../formats/text';
import { Diagnostics } from './common';
import { L } from './layers';
import type { PcbDocument, PrimStream } from './pcb';

export interface FootprintEntry {
  name: string;
  description: string;
  height: string;
  /** Storage it was read from; undefined for a footprint added in this session. */
  storage?: string;
  original?: Footprint;
  doc: PcbDocument;
  /** False while a footprint read from the file hasn't been opened yet (its document isn't made until then). */
  readonly loaded?: boolean;
}

/** A library footprint as an entry: its editable document is made the first time it's shown. */
export function libEntry(f: Footprint): FootprintEntry {
  let doc: PcbDocument | null = null;
  const e = { name: f.name, description: f.description, height: f.height, storage: f.storage, original: f } as FootprintEntry;
  Object.defineProperty(e, 'doc', { enumerable: true, configurable: true, get: () => (doc ??= footprintDoc(e.name, f.records)), set: (v: PcbDocument) => { doc = v; } });
  Object.defineProperty(e, 'loaded', { enumerable: false, configurable: true, get: () => !!doc });
  return e;
}

/** Pads and primitives of a footprint, from its records while it hasn't been opened. */
export function footprintCounts(e: FootprintEntry): { pads: number; prims: number } {
  if (e.loaded === false && e.original) {
    const recs = e.original.records;
    let pads = 0;
    for (const r of recs) if (r.tag === PCB_TAG.PAD) pads++;
    return { pads, prims: recs.length };
  }
  const prims = e.doc.prims;
  return { pads: prims.filter((p) => p.kind === 'pad').length, prims: prims.length };
}

export interface PcbLibDocument {
  kind: 'PcbLib';
  name: string;
  lib: PcbLibrary | null;
  footprints: FootprintEntry[];
  /** Storages of footprints deleted since opening. */
  removed: string[];
  /** Bumped by structural edits (add, delete, rename) so views refresh. */
  version: number;
  diags: Diagnostics;
}

const STORAGE_ORDER = [...PRIM_STORAGES, 'ComponentBodies6'];

/** A footprint as an editable document. */
export function footprintDoc(name: string, records: PcbRawRecord[]): PcbDocument {
  const streams = new Map<string, PrimStream>();
  for (const st of STORAGE_ORDER) streams.set(st, { storage: st, records: [] });
  for (const r of records) {
    const st = storageFor(r.tag);
    if (!streams.has(st)) streams.set(st, { storage: st, records: [] });
    streams.get(st)!.records.push(r);
  }
  const doc: PcbDocument = {
    kind: 'PcbDoc', name, cfb: { root: newEntry('Root Entry', 'root'), majorVersion: 3 },
    board: { bag: undefined, origin: { x: 0, y: 0 }, outline: [], vertices: [], copperStack: [L.TOP, L.BOTTOM], layerNames: new Map() },
    nets: [], components: [], prims: [], streams, dirty: new Set(), diags: new Diagnostics(),
    rules: defaultRules(), rulesInFile: false, classes: [], polygons: [], dimensions: [],
  };
  rebuildPrims(doc);
  return doc;
}

export function openPcbLib(bytes: Uint8Array, name: string): PcbLibDocument {
  const lib = readPcbLib(bytes, name);
  return {
    kind: 'PcbLib', name, lib, removed: [], version: 0, diags: lib.diags,
    footprints: lib.footprints.map(libEntry),
  };
}

/** File › New › Library › PCB Library: one empty footprint, PCBCOMPONENT_1, as Altium starts. */
export function newPcbLib(name: string): PcbLibDocument {
  return openPcbLib(writePcbLib([{ name: 'PCBCOMPONENT_1', records: [] }], name), name);
}

export const footprintRecords = (doc: PcbDocument): PcbRawRecord[] => STORAGE_ORDER.flatMap((st) => doc.streams.get(st)?.records ?? []).concat(
  [...doc.streams.keys()].filter((k) => !STORAGE_ORDER.includes(k)).flatMap((k) => doc.streams.get(k)!.records));

const changed = (e: FootprintEntry) => !e.original || (e.loaded !== false && e.doc.dirty.size > 0) || e.name !== e.original.name || e.description !== e.original.description || e.height !== e.original.height;

export function uniqueFootprintName(d: PcbLibDocument, base = 'PCBCOMPONENT'): string {
  const names = new Set(d.footprints.map((f) => f.name.toLowerCase()));
  for (let i = 1; ; i++) if (!names.has(`${base}_${i}`.toLowerCase())) return `${base}_${i}`;
}

function pascalSub(s: string): Uint8Array {
  const b = binToBytes(s.slice(0, 255));
  return new BinWriter(b.length + 5).u32(b.length + 1).u8(b.length).bytes(b).finish();
}

function storageName(root: CfbEntry, name: string, keep?: string): string {
  if (keep) return keep;
  let st = name.replace(/[/\\:*?"<>|!]/g, '_').slice(0, 31);
  for (let i = 1; cfbFind(root, st); i++) st = `${name.replace(/[/\\:*?"<>|!]/g, '_').slice(0, 27)}_${i}`;
  return st;
}

export function writePcbLibDoc(d: PcbLibDocument): Uint8Array {
  if (!d.lib) return writePcbLib(d.footprints.map((f) => ({ name: f.name, description: f.description, height: f.height, records: footprintRecords(f.doc) })), d.name);
  const root = cloneCfb(d.lib.cfb.root);
  root.children = root.children.filter((c) => !d.removed.includes(c.name));
  for (const f of d.footprints) {
    if (!changed(f)) continue;
    // A renamed footprint moves to a storage named after it (Altium finds footprints by name)
    if (f.storage && f.original && f.name !== f.original.name) {
      const old = root.children.find((c) => c.name === f.storage);
      root.children = root.children.filter((c) => c !== old);
      const st = storageName(root, f.name);
      if (old) { const moved = cloneCfb(old); moved.name = st; root.children.push(moved); }
      f.storage = st;
    }
    const st = storageName(root, f.name, f.storage);
    const records = footprintRecords(f.doc);
    // Parameters: keep every original key, update the three the editor shows
    const prev = f.storage ? cfbFind(root, `${f.storage}/Parameters`)?.data : undefined;
    let bag = new PropertyBag();
    if (prev && prev.length >= 4) { const n = new DataView(prev.buffer, prev.byteOffset).getUint32(0, true) & 0x00ffffff; bag = PropertyBag.parse(prev.subarray(4, 4 + n)); }
    bag.set('PATTERN', f.name); bag.set('HEIGHT', f.height || '0mil'); bag.set('DESCRIPTION', f.description);
    const pb = bag.toBytes();
    cfbPut(root, `${st}/Parameters`, new BinWriter(pb.length + 4).u32(pb.length).bytes(pb).finish());
    cfbPut(root, `${st}/Header`, countHeader(records.length));
    cfbPut(root, `${st}/Data`, new BinWriter(4096).bytes(pascalSub(f.name)).bytes(joinBinaryRecords(records)).finish());
    if (!cfbFind(root, `${st}/WideStrings`)) cfbPut(root, `${st}/WideStrings`, new Uint8Array(0));
    f.storage = st;
  }
  // Library/Data: the original property block, then the footprint list
  const old = cfbFind(root, 'Library/Data')?.data;
  let props = newLibraryRecord(d.name).toBytes();
  if (old && old.length >= 4) {
    const r = new BinReader(old); const n = r.u32() & 0x00ffffff;
    // A header an earlier Konium wrote (a few layer names) gets AD17's whole layer system
    if (!isThinRecord(PropertyBag.parse(old.slice(4, 4 + n)))) props = old.slice(4, 4 + n);
  }
  const w = new BinWriter(1024).u32(props.length).bytes(props).u32(d.footprints.length);
  for (const f of d.footprints) w.bytes(pascalSub(f.name));
  cfbPut(root, 'Library/Data', w.finish());
  return writeCfb(root);
}

/**
 * Design › Make PCB Library: one footprint per distinct pattern on the board, taken from its
 * first instance, turned back to 0° and moved to the origin; designator and comment texts and
 * net assignments are left behind.
 */
export function footprintsFromBoard(doc: PcbDocument): FootprintDef[] {
  const out: FootprintDef[] = [];
  const seen = new Set<string>();
  for (const c of doc.components) {
    const key = c.pattern.toLowerCase();
    if (!c.pattern || seen.has(key)) continue;
    seen.add(key);
    // A bottom-side part is its footprint reflected top-to-bottom then turned: undo both, back onto the top
    const bottom = c.layer === L.BOTTOM;
    const rot = bottom ? 180 + c.rotation : -c.rotation;
    const map = placement(c.at, rot, { x: -c.at.x, y: -c.at.y }, bottom);
    const records: PcbRawRecord[] = [];
    for (const p of doc.prims) {
      if (!('component' in p) || p.component !== c.index) continue;
      if (p.kind === 'text' && (p.isDesignator || p.isComment)) continue;
      const rec = doc.streams.get(p.src.storage)?.records[p.src.index];
      if (rec) records.push(placeRecord(transformRecord(rec, map, rot, { mirror: bottom, flip: bottom, storage: p.src.storage }), 0, 0, 0xffff));
    }
    out.push({ name: c.pattern, description: c.bag.get('FOOTPRINTDESCRIPTION') ?? '', height: c.bag.get('HEIGHT') ?? '0mil', records });
  }
  return out;
}

/** Saved: what's in memory is now the file's content. */
export function markPcbLibSaved(d: PcbLibDocument, bytes: Uint8Array): void {
  const lib = readPcbLib(bytes, d.name);
  d.lib = lib;
  d.removed = [];
  const byStorage = new Map(lib.footprints.map((x) => [x.storage, x]));
  for (const f of d.footprints) {
    f.original = f.storage ? byStorage.get(f.storage) : undefined;
    if (f.loaded !== false) f.doc.dirty.clear();
  }
}
