/**
 * Konium Designer's requirements documents (.ReqDoc): a project's requirements, under their
 * sections, as JSON. Version 1.
 */
import { newRequirements, normaliseRequirements, type Requirements } from '../model/requirements';

export interface ReqDocument { kind: 'ReqDoc'; name: string; reqs: Requirements; dirty: boolean }

export const isReqDoc = (bytes: Uint8Array) => /^\s*\{\s*"koniumRequirements"/.test(new TextDecoder().decode(bytes.subarray(0, 64)));

export function readReqDoc(bytes: Uint8Array, name: string): ReqDocument {
  const text = new TextDecoder().decode(bytes).trim();
  let j: { koniumRequirements?: number; prefix?: string; rows?: unknown[] };
  try { j = (text ? JSON.parse(text) : {}) as typeof j; }
  catch (e) { throw new Error(`${name} is damaged, or cut short: ${(e as Error).message}`); }
  return { kind: 'ReqDoc', name, reqs: normaliseRequirements(j as Partial<Requirements>), dirty: false };
}

export function writeReqDoc(d: ReqDocument): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify({ koniumRequirements: 1, prefix: d.reqs.prefix, rows: d.reqs.rows }, null, 2)}\n`);
}

export const newReqDoc = (name: string): ReqDocument => ({ kind: 'ReqDoc', name, reqs: newRequirements(), dirty: true });
