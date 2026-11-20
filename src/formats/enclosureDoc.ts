/**
 * Konium Designer's enclosure documents (.Enclosure): the enclosure designer's settings for a
 * board, as JSON (the box itself is made from them and the board as it is now). Version 2; the
 * first version's documents are read and saved as version 2.
 */
import { defaultSpec, normaliseSpec, type EnclosureSpec } from '../model/enclosure';
import { FORMERS } from '../core/former';

export interface EnclosureDocument { kind: 'Enclosure'; name: string; spec: EnclosureSpec; dirty: boolean }

const MARK = new RegExp(`^\\s*\\{\\s*"(?:${['konium', ...FORMERS].join('|')})Enclosure"`);
export const isEnclosure = (bytes: Uint8Array) => MARK.test(new TextDecoder().decode(bytes.subarray(0, 64)));

export function readEnclosure(bytes: Uint8Array, name: string): EnclosureDocument {
  const j = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown> & { koniumEnclosure?: number; spec?: Partial<EnclosureSpec> };
  return { kind: 'Enclosure', name, spec: normaliseSpec(j.spec ?? {}), dirty: false };
}

export function writeEnclosure(d: EnclosureDocument): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify({ koniumEnclosure: 2, spec: d.spec }, null, 2)}\n`);
}

export const newEnclosure = (name: string, board: string): EnclosureDocument => ({ kind: 'Enclosure', name, spec: defaultSpec(board), dirty: true });
