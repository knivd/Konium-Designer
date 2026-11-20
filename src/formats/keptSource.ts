/**
 * Another tool's file kept with what Konium made of it (R10, R11): a board's or a design's original
 * file stored in the converted documents (a stream of the PcbDoc's, of the first SchDoc's) with a
 * fingerprint of what the import made; written back as that tool wrote it while the documents are
 * still what the import made of them. The keys a tool's import adds (`skip`) are left out of the
 * fingerprints.
 */
import { cfbPut, cfbStream } from './cfb/cfb';
import { PRIM_STORAGES } from './altium/pcbdoc';
import type { PropertyBag } from './altium/props';
import { recordSig } from './kicad/kept';
import type { PcbDocument } from '../model/pcb';
import type { SchDocument } from '../model/sch';

/** Everything a board is (its primitives, parts, nets, pours, rules, classes, board settings but the `skip` keys): a fingerprint. */
export function boardSig(doc: PcbDocument, skip: RegExp): string {
  let h = 0x811c9dc5, n = 0;
  const mix = (s: string) => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } h ^= 10; h = Math.imul(h, 0x01000193) >>> 0; n++; };
  const bag = (b: PropertyBag | undefined, sk?: RegExp) => { if (!b) return; for (const k of b.keys()) if (!sk?.test(k)) mix(`${k}=${b.getRaw(k) ?? ''}`); mix('|'); };
  for (const st of [...PRIM_STORAGES, 'ComponentBodies6']) for (const rec of doc.streams.get(st)?.records ?? []) mix(recordSig(rec));
  for (const c of doc.components) bag(c.bag, skip);
  for (const x of doc.nets) bag(x.bag);
  for (const p of doc.polygons) bag(p.bag, skip);
  for (const r of doc.rules) bag(r.bag);
  for (const c of doc.classes) mix(`${c.name}:${c.kind}:${c.members.join(',')}`);
  bag(doc.board.bag, skip);
  return `${h.toString(16)}:${n}`;
}

/** The file a board was read from, kept in it (`storage`/Data), and its fingerprint (board setting `sigKey`). */
export function keepBoardSource(doc: PcbDocument, bytes: Uint8Array, storage: string, sigKey: string, skip: RegExp): void {
  cfbPut(doc.cfb.root, `${storage}/Data`, bytes);
  doc.board.bag?.set(sigKey, boardSig(doc, skip));
  doc.dirty.add('Board6');
}

/** The file a board was read from, while the board is still what the import made of it. */
export function keptBoardSource(doc: PcbDocument, storage: string, sigKey: string, skip: RegExp): Uint8Array | null {
  const sig = doc.board.bag?.get(sigKey);
  if (!sig) return null;
  const data = cfbStream(doc.cfb.root, `${storage}/Data`);
  return data && sig === boardSig(doc, skip) ? data : null;
}

const hash = (parts: string[]): string => {
  let h = 0x811c9dc5;
  for (const t of parts) { for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } h ^= 10; h = Math.imul(h, 0x01000193) >>> 0; }
  return `${h.toString(16)}:${parts.length}`;
};

/** A sheet's records (but the `skip` keys and unique IDs): a fingerprint. */
export function sheetSig(doc: SchDocument, skip: RegExp): string {
  const parts: string[] = [];
  for (const r of doc.records) {
    const b = r.bag;
    if (!b) { parts.push(String(r.data?.length ?? 0)); continue; }
    for (const k of b.keys()) if (!skip.test(k) && k !== 'UNIQUEID') parts.push(`${k}=${b.getRaw(k) ?? ''}`);
    parts.push('|');
  }
  return hash(parts);
}

const headerOf = (doc: SchDocument) => doc.records.find((r) => r.bag?.int('RECORD', -1) === 31)?.bag;

/**
 * A design's sheets marked as it (the file's ID, each sheet's place and fingerprint: `markKey`,
 * `sigKey` in the sheet's header), the file kept with the first (`storage`/Data).
 */
export function keepDesignSource(sheets: SchDocument[], bytes: Uint8Array, storage: string, markKey: string, sigKey: string, skip: RegExp): void {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]!; h = Math.imul(h, 0x01000193) >>> 0; }
  const id = h.toString(16);
  sheets.forEach((d, i) => {
    const b = headerOf(d);
    if (!b) return;
    b.set(markKey, `${id} ${i} ${sheets.length}`);
    b.set(sigKey, sheetSig(d, skip));
    if (i === 0 && d.cfb) cfbPut(d.cfb.root, `${storage}/Data`, bytes);
  });
}

/** The file a design's sheets were read from, while they are all of it and as the import made them. */
export function keptDesignSource(sheets: SchDocument[], storage: string, markKey: string, sigKey: string, skip: RegExp): Uint8Array | null {
  const marks = sheets.map((d) => (headerOf(d)?.get(markKey) ?? '').split(' '));
  if (!marks.length || marks.some((m) => m.length !== 3 || m[0] !== marks[0]![0] || Number(m[2]) !== sheets.length)) return null;
  if (new Set(marks.map((m) => m[1])).size !== sheets.length) return null;
  if (sheets.some((d) => headerOf(d)?.get(sigKey) !== sheetSig(d, skip))) return null;
  const first = sheets[marks.findIndex((m) => m[1] === '0')];
  return first?.cfb ? cfbStream(first.cfb.root, `${storage}/Data`) ?? null : null;
}
