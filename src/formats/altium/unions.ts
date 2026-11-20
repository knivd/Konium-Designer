/**
 * Unions in a PcbDoc, as AD17 writes them (checked on real boards):
 * - each primitive's union index, a u32 in its first subrecord — Tracks6 at 36, Arcs6 at 48,
 *   Texts6 at 119 (other kinds are not known yet); components and pours by UNIONINDEX;
 * - UnionNames: u32 count, then per union u32 index, u32 byte length, its name in UTF-16
 *   ("Unions", "Unions 1", "Interactive Length Tunings 3", "Drill Tables" …);
 * - SmartUnions: unions that rebuild themselves (UNIONTYPE 1 a drill table, 4 a length tuning),
 *   each a text record (u32 length, |KEY=VALUE|…, 0). They repeat keys, so they are kept as text.
 */
import type { CfbEntry } from '../cfb/cfb';
import { cfbPut, cfbStream } from '../cfb/cfb';
import { get, put, type Field } from './pcbLayouts';
import type { PcbRawRecord } from './framing';

export const UNION_FIELD: Record<string, Field> = {
  Tracks6: { off: 36, t: 'u32' }, Arcs6: { off: 48, t: 'u32' }, Texts6: { off: 119, t: 'u32' },
};

export function recordUnion(storage: string, rec: PcbRawRecord): number {
  const f = UNION_FIELD[storage], s = rec.subs[0];
  return f && s ? get(s, f) ?? 0 : 0;
}
/** A copy of a record in a union (0: none); null when this kind's record can't hold one. */
export function withRecordUnion(storage: string, rec: PcbRawRecord, u: number): PcbRawRecord | null {
  const f = UNION_FIELD[storage];
  if (!f || !rec.subs[0] || rec.subs[0].length < f.off + 4) return null;
  const s = rec.subs[0].slice();
  put(s, f, u);
  return { tag: rec.tag, subs: [s, ...rec.subs.slice(1)] };
}

export interface UnionName { index: number; name: string }

export function readUnionNames(root: CfbEntry): UnionName[] {
  const d = cfbStream(root, 'UnionNames/Data');
  if (!d || d.length < 4) return [];
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const n = v.getUint32(0, true), out: UnionName[] = [];
  let i = 4;
  for (let k = 0; k < n && i + 8 <= d.length; k++) {
    const index = v.getUint32(i, true), len = Math.min(v.getUint32(i + 4, true), d.length - i - 8);
    i += 8;
    let name = '';
    for (let j = 0; j + 1 < len; j += 2) { const c = d[i + j]! | (d[i + j + 1]! << 8); if (c) name += String.fromCharCode(c); }
    i += len;
    out.push({ index, name });
  }
  return out;
}

export function writeUnionNames(root: CfbEntry, names: UnionName[]): void {
  const parts: number[] = [];
  const u32 = (x: number) => parts.push(x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, (x >>> 24) & 0xff);
  u32(names.length);
  for (const n of names) {
    const len = (n.name.length + 1) * 2;
    u32(n.index); u32(len);
    for (const ch of n.name) { const c = ch.charCodeAt(0); parts.push(c & 0xff, c >> 8); }
    parts.push(0, 0);
  }
  cfbPut(root, 'UnionNames/Data', new Uint8Array(parts));
  cfbPut(root, 'UnionNames/Header', new Uint8Array([1, 0, 0, 0]));
}

const latin1 = (b: Uint8Array) => { let s = ''; for (const c of b) s += String.fromCharCode(c); return s; };

/** SmartUnions records as their text (without the closing 0). */
export function readSmartUnions(root: CfbEntry): string[] {
  const d = cfbStream(root, 'SmartUnions/Data');
  if (!d) return [];
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength), out: string[] = [];
  let i = 0;
  while (i + 4 <= d.length) {
    const len = v.getUint32(i, true);
    const body = d.subarray(i + 4, i + 4 + len);
    out.push(latin1(body[body.length - 1] === 0 ? body.subarray(0, body.length - 1) : body));
    i += 4 + len;
  }
  return out;
}

export function writeSmartUnions(root: CfbEntry, recs: string[]): void {
  const parts: number[] = [];
  for (const r of recs) {
    const len = r.length + 1;
    parts.push(len & 0xff, (len >>> 8) & 0xff, (len >>> 16) & 0xff, (len >>> 24) & 0xff);
    for (const ch of r) parts.push(ch.charCodeAt(0) & 0xff);
    parts.push(0);
  }
  cfbPut(root, 'SmartUnions/Data', new Uint8Array(parts));
  cfbPut(root, 'SmartUnions/Header', new Uint8Array([recs.length & 0xff, (recs.length >>> 8) & 0xff, 0, 0]));
}

/** A smart union's index and type. */
export function smartInfo(rec: string): { index: number; type: number } {
  const i = /\|UNIONINDEX=(\d+)/.exec(rec), t = /\|UNIONTYPE=(\d+)/.exec(rec);
  return { index: i ? Number(i[1]) : 0, type: t ? Number(t[1]) : 0 };
}
