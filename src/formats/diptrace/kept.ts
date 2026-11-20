/**
 * R12, DipTrace's files both ways: a DipTrace board (.dipxml) and schematic (.dchxml) read into
 * Konium keep their files (the PcbDoc's, the first SchDoc's DipTraceSource stream) with their names
 * and a fingerprint of what the import made (DIPTRACESIG on the board; DIPTRACEDCH and
 * DIPTRACESHEETSIG on each sheet). Exported for DipTrace while they are still what the import made
 * of them, they are the files DipTrace wrote, byte for byte; once changed, the export writes them
 * from Konium's documents.
 */
import { readPcbDoc, writePcbDoc } from '../altium/pcbdoc';
import { readSchDoc, writeSchDoc } from '../altium/schdoc';
import { keepBoardSource, keptBoardSource, keepDesignSource, keptDesignSource } from '../keptSource';
import type { PcbDocument } from '../../model/pcb';
import type { SchDocument } from '../../model/sch';

export const DIPTRACE_SOURCE = 'DipTraceSource';
const SKIP = /^DIPTRACE/;
const headerOf = (doc: SchDocument) => doc.records.find((r) => r.bag?.int('RECORD', -1) === 31)?.bag;

/** A board converted from a DipTrace file, with that file kept in it. */
export function keepDip(pcb: Uint8Array, docName: string, src: Uint8Array, fileName: string): Uint8Array {
  const doc = readPcbDoc(pcb, docName);
  doc.board.bag?.set('DIPTRACEFILE', fileName.replace(/^.*[\\/]/, ''));
  keepBoardSource(doc, src, DIPTRACE_SOURCE, 'DIPTRACESIG', SKIP);
  return writePcbDoc(doc);
}

/** The DipTrace file a board was read from (and its name), while the board is still what the import made of it. */
export function keptDip(doc: PcbDocument): { file: string; bytes: Uint8Array } | null {
  const bytes = keptBoardSource(doc, DIPTRACE_SOURCE, 'DIPTRACESIG', SKIP);
  const file = doc.board.bag?.get('DIPTRACEFILE');
  return bytes && file ? { file, bytes } : null;
}

/** A schematic's sheets converted from a DipTrace file, the file kept with the first. */
export function keepDch(sheets: { name: string; bytes: Uint8Array }[], src: Uint8Array, fileName: string): { name: string; bytes: Uint8Array }[] {
  if (!sheets.length) return sheets;
  const docs = sheets.map((s) => readSchDoc(s.bytes, s.name));
  headerOf(docs[0]!)?.set('DIPTRACEFILE', fileName.replace(/^.*[\\/]/, ''));
  keepDesignSource(docs, src, DIPTRACE_SOURCE, 'DIPTRACEDCH', 'DIPTRACESHEETSIG', SKIP);
  return sheets.map((s, i) => ({ name: s.name, bytes: writeSchDoc(docs[i]!) }));
}

/** The DipTrace file a set of sheets was read from (and its name), while they are all of it and as the import made them. */
export function keptDch(sheets: SchDocument[]): { file: string; bytes: Uint8Array } | null {
  const bytes = keptDesignSource(sheets, DIPTRACE_SOURCE, 'DIPTRACEDCH', 'DIPTRACESHEETSIG', SKIP);
  if (!bytes) return null;
  const first = sheets.find((d) => /^\S+ 0 /.test(headerOf(d)?.get('DIPTRACEDCH') ?? ''));
  const file = first ? headerOf(first)?.get('DIPTRACEFILE') : undefined;
  return file ? { file, bytes } : null;
}
