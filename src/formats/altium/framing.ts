import { BinReader, BinWriter } from '../bin';
import { PropertyBag } from './props';

/* ─── Schematic FileHeader / symbol streams ──────────────────────────────────────────────
 * Each record: u32 LE header; low 24 bits = payload size, high byte = payload kind
 * (0 = property text, NUL-terminated; 1 = binary, e.g. SchLib pins).
 */

export interface SchRawRecord {
  kind: number;            // 0 text, 1 binary, other = unknown (kept verbatim)
  data: Uint8Array;        // payload as read (binary) — for text, bag.toBytes() is authoritative
  bag?: PropertyBag;
  /** Schematics: the record lives in the Additional stream (harnesses), not FileHeader. */
  additional?: boolean;
}

export function splitSchRecords(stream: Uint8Array): SchRawRecord[] {
  const r = new BinReader(stream);
  const out: SchRawRecord[] = [];
  while (r.remaining >= 4) {
    const h = r.u32();
    const size = h & 0x00ffffff;
    const kind = h >>> 24;
    const data = r.bytes(Math.min(size, r.remaining));
    out.push(kind === 0 ? { kind, data, bag: PropertyBag.parse(data) } : { kind, data });
  }
  return out;
}

export function joinSchRecords(records: SchRawRecord[]): Uint8Array {
  const w = new BinWriter(64 * 1024);
  for (const rec of records) {
    const data = rec.bag ? rec.bag.toBytes() : rec.data;
    if (data.length > 0xffffff) throw new Error('schematic record exceeds 16 MiB');
    w.u32(((rec.kind & 0xff) << 24) | data.length);
    w.bytes(data);
  }
  return w.finish();
}

/* ─── PCB text-property streams (Board6, Nets6, Components6, Classes6, Rules6 …) ─────────
 * Each record: u32 LE length + property text (usually NUL-terminated).
 */

export function splitTextRecords(stream: Uint8Array): PropertyBag[] {
  const r = new BinReader(stream);
  const out: PropertyBag[] = [];
  while (r.remaining >= 4) {
    const n = r.u32() & 0x00ffffff; // high byte flags binary payloads (rare)
    out.push(PropertyBag.parse(r.bytes(Math.min(n, r.remaining))));
  }
  return out;
}

export function joinTextRecords(bags: PropertyBag[]): Uint8Array {
  const w = new BinWriter(16 * 1024);
  for (const b of bags) { const d = b.toBytes(); w.u32(d.length); w.bytes(d); }
  return w.finish();
}

/* ─── PCB binary primitive streams (Tracks6, Arcs6, Vias6, Pads6, Fills6, Texts6 …) ──────
 * Each record: u8 type tag, then N subrecords of (u32 LE length + payload).
 */

export const PCB_TAG = { ARC: 1, PAD: 2, VIA: 3, TRACK: 4, TEXT: 5, FILL: 6, REGION: 11, MODEL: 12 } as const;

/** Subrecords per record type. Types not listed cannot be framed and stay verbatim. */
export const SUBRECORDS: Record<number, number> = { 1: 1, 2: 6, 3: 1, 4: 1, 5: 2, 6: 1, 11: 1, 12: 1 };

export interface PcbRawRecord {
  tag: number;
  subs: Uint8Array[];
  /** A text's words for the WideStrings6 entry it gets on save (its index 0xFFFFFFFF): Unicode the 8-bit string can't hold. */
  wide?: string;
}

export function splitBinaryRecords(stream: Uint8Array): PcbRawRecord[] {
  const r = new BinReader(stream);
  const out: PcbRawRecord[] = [];
  while (!r.eof) {
    const tag = r.u8();
    const n = SUBRECORDS[tag];
    if (n === undefined) throw new Error(`unknown primitive tag ${tag} at offset ${r.pos - 1}`);
    const subs: Uint8Array[] = [];
    for (let i = 0; i < n; i++) {
      if (r.eof && tag === PCB_TAG.PAD && i === 5) break; // last pad subrecord may be absent
      subs.push(r.bytes(r.u32()));
    }
    out.push({ tag, subs });
  }
  return out;
}

export function joinBinaryRecords(records: PcbRawRecord[]): Uint8Array {
  const w = new BinWriter(64 * 1024);
  for (const rec of records) {
    w.u8(rec.tag);
    for (const s of rec.subs) { w.u32(s.length); w.bytes(s); }
  }
  return w.finish();
}

/** Every PCB storage has a 4-byte Header stream holding the record count. */
export function countHeader(n: number): Uint8Array {
  return new BinWriter(4).u32(n).finish();
}
