/**
 * R11, Cadence's files both ways: an Allegro board (.brd) and an OrCAD Capture design (.dsn) read
 * into Konium keep their files (the PcbDoc's, the first SchDoc's CadenceSource stream) with their
 * names and a fingerprint of what the import made (CADENCESIG on the board; CADENCEDSN and
 * CADENCESHEETSIG on each sheet). Exported for Cadence while they are still what the import made of
 * them, they are the files Allegro and Capture wrote, byte for byte; once changed, the export writes
 * them in the ASCII formats Cadence's translators read.
 */
import { readPcbDoc, writePcbDoc } from './altium/pcbdoc';
import { readSchDoc, writeSchDoc } from './altium/schdoc';
import { keepBoardSource, keptBoardSource, keepDesignSource, keptDesignSource } from './keptSource';
import type { PcbDocument } from '../model/pcb';
import type { SchDocument } from '../model/sch';

export const CADENCE_SOURCE = 'CadenceSource';
const SKIP = /^CADENCE/;
const headerOf = (doc: SchDocument) => doc.records.find((r) => r.bag?.int('RECORD', -1) === 31)?.bag;

/** A board converted from an Allegro file, with that file kept in it. */
export function keepBrd(pcb: Uint8Array, docName: string, brd: Uint8Array, fileName: string): Uint8Array {
  const doc = readPcbDoc(pcb, docName);
  doc.board.bag?.set('CADENCEFILE', fileName.replace(/^.*[\\/]/, ''));
  keepBoardSource(doc, brd, CADENCE_SOURCE, 'CADENCESIG', SKIP);
  return writePcbDoc(doc);
}

/** The Allegro file a board was read from (and its name), while the board is still what the import made of it. */
export function keptBrd(doc: PcbDocument): { file: string; bytes: Uint8Array } | null {
  const bytes = keptBoardSource(doc, CADENCE_SOURCE, 'CADENCESIG', SKIP);
  const file = doc.board.bag?.get('CADENCEFILE');
  return bytes && file ? { file, bytes } : null;
}

/** A design's sheets converted from a Capture file, the file kept with the first. */
export function keepDsn(sheets: { name: string; bytes: Uint8Array }[], dsn: Uint8Array, fileName: string): { name: string; bytes: Uint8Array }[] {
  if (!sheets.length) return sheets;
  const docs = sheets.map((s) => readSchDoc(s.bytes, s.name));
  headerOf(docs[0]!)?.set('CADENCEFILE', fileName.replace(/^.*[\\/]/, ''));
  keepDesignSource(docs, dsn, CADENCE_SOURCE, 'CADENCEDSN', 'CADENCESHEETSIG', SKIP);
  return sheets.map((s, i) => ({ name: s.name, bytes: writeSchDoc(docs[i]!) }));
}

/** The Capture file a set of sheets was read from (and its name), while they are all of it and as the import made them. */
export function keptDsn(sheets: SchDocument[]): { file: string; bytes: Uint8Array } | null {
  const bytes = keptDesignSource(sheets, CADENCE_SOURCE, 'CADENCEDSN', 'CADENCESHEETSIG', SKIP);
  if (!bytes) return null;
  const first = sheets.find((d) => /^\S+ 0 /.test(headerOf(d)?.get('CADENCEDSN') ?? ''));
  const file = first ? headerOf(first)?.get('CADENCEFILE') : undefined;
  return file ? { file, bytes } : null;
}
