/**
 * Per-primitive records AD keeps beside the primitive streams, keyed by the primitive's index in
 * its stream: ExtendedPrimitiveInformation (solder and paste mask expansions of tracks, arcs,
 * fills and regions) and UniqueIDPrimitiveInformation (every pad's unique ID).
 *   |PRIMITIVEINDEX=1944|PRIMITIVEOBJECTID=Track|TYPE=Mask|SOLDERMASKEXPANSIONMODE=Manual|SOLDERMASKEXPANSION_MANUAL=1.1811mil|…
 * An index is only true while the stream keeps its order, so each entry is tied to its record on
 * reading and written back with the record's index as it is then: deleting a track no longer hands
 * its mask expansion (or a pad its unique ID) to the next one.
 */
import { PropertyBag } from './props';
import { FORMERS_CAP } from '../../core/former';
/** Pads' own blocks as boards saved under the app's earlier names have them. */
const PAD_TYPES = ['KoniumPad', ...FORMERS_CAP.map((f) => `${f}Pad`)];
import { countHeader, joinTextRecords, splitTextRecords, type PcbRawRecord } from './framing';
import { cfbPut, cfbStream, type CfbEntry } from '../cfb/cfb';

export const SIDE_STREAMS = ['ExtendedPrimitiveInformation', 'UniqueIDPrimitiveInformation'] as const;
export type SideStream = typeof SIDE_STREAMS[number];

/** PRIMITIVEOBJECTID → storage, in AD's object order (the order the entries are written in). */
const OBJECTS: [string, string][] = [['Arc', 'Arcs6'], ['Pad', 'Pads6'], ['Via', 'Vias6'], ['Track', 'Tracks6'], ['Text', 'Texts6'], ['Fill', 'Fills6'], ['Region', 'Regions6'], ['ComponentBody', 'ComponentBodies6']];
const STORAGE = new Map(OBJECTS);
export const OBJECT_OF = new Map(OBJECTS.map(([o, s]) => [s, o]));

export interface PrimInfo { ExtendedPrimitiveInformation?: PropertyBag[]; UniqueIDPrimitiveInformation?: PropertyBag[] }
const info = new WeakMap<PcbRawRecord, PrimInfo>();
/** Entries whose primitive couldn't be found, written back as they were. */
export interface SideState { orphans: Record<SideStream, PropertyBag[]>; present: Set<SideStream> }

/** Tie each entry to its record. */
export function attachPrimInfo(root: CfbEntry, records: (storage: string) => PcbRawRecord[] | undefined): SideState {
  const st: SideState = { orphans: { ExtendedPrimitiveInformation: [], UniqueIDPrimitiveInformation: [] }, present: new Set() };
  for (const stream of SIDE_STREAMS) {
    const data = cfbStream(root, `${stream}/Data`);
    if (!data) continue;
    st.present.add(stream);
    let bags: PropertyBag[];
    try { bags = splitTextRecords(data); } catch { continue; }
    for (const b of bags) {
      const storage = STORAGE.get(b.get('PRIMITIVEOBJECTID') ?? '');
      const rec = storage ? records(storage)?.[Number(b.get('PRIMITIVEINDEX'))] : undefined;
      if (!rec) { st.orphans[stream].push(b); continue; }
      const i = info.get(rec) ?? {};
      (i[stream] ??= []).push(b);
      info.set(rec, i);
    }
  }
  return st;
}

export const primInfo = (rec: PcbRawRecord): PrimInfo | undefined => info.get(rec);

/** A record that takes another's place (an edit, a move) keeps that one's entries. */
export function carryPrimInfo(from: PcbRawRecord, to: PcbRawRecord): void {
  const i = info.get(from);
  if (i && from !== to && !info.has(to)) info.set(to, i);
}

/** Set (or with null, clear) one record's entries of a stream. */
export function setPrimInfo(rec: PcbRawRecord, stream: SideStream, bags: PropertyBag[] | null): void {
  const i = { ...(info.get(rec) ?? {}) };
  if (bags?.length) i[stream] = bags; else delete i[stream];
  info.set(rec, i);
}

/**
 * Write the streams again when the primitives they point at may have moved (a storage they refer
 * to is dirty) or an entry changed (the stream itself is dirty); else they stay byte for byte.
 */
export function writePrimInfo(root: CfbEntry, streams: Map<string, { records: PcbRawRecord[] }>, dirty: Set<string>, st: SideState | undefined): void {
  for (const stream of SIDE_STREAMS) {
    const touched = dirty.has(stream) || OBJECTS.some(([, s]) => dirty.has(s));
    if (!touched) continue;
    const out: PropertyBag[] = [];
    for (const [obj, storage] of OBJECTS) {
      const recs = streams.get(storage)?.records ?? [];
      recs.forEach((r, index) => {
        for (const b of info.get(r)?.[stream] ?? []) {
          const nb = b.clone();
          nb.set('PRIMITIVEINDEX', String(index));
          nb.set('PRIMITIVEOBJECTID', obj);
          out.push(nb);
        }
      });
    }
    out.push(...(st?.orphans[stream] ?? []));
    if (!out.length && !st?.present.has(stream)) continue;
    cfbPut(root, `${stream}/Data`, joinTextRecords(out));
    cfbPut(root, `${stream}/Header`, countHeader(out.length));
  }
}

/* ─── Mask expansions (ExtendedPrimitiveInformation TYPE=Mask) ────────────────────────── */

export type MaskMode = 'None' | 'Rule' | 'Manual';
export interface MaskExpansion { mode: MaskMode; value: string }
export interface Masks { solder: MaskExpansion; paste: MaskExpansion }

/** A track's, arc's, fill's or region's mask expansions; without an entry AD shows No Mask. */
export function masksOf(rec: PcbRawRecord): Masks {
  const b = info.get(rec)?.ExtendedPrimitiveInformation?.find((x) => (x.get('TYPE') ?? '').toLowerCase() === 'mask');
  const one = (k: 'SOLDER' | 'PASTE'): MaskExpansion => {
    const m = (b?.get(`${k}MASKEXPANSIONMODE`) ?? 'None').trim();
    return { mode: (m === 'Rule' || m === 'Manual' ? m : 'None'), value: (b?.get(`${k}MASKEXPANSION_MANUAL`) ?? '0mil').trim() };
  };
  return { solder: one('SOLDER'), paste: one('PASTE') };
}

/** The record's Mask entry for these expansions (none when both are No Mask), keeping its other entries. */
export function setMasks(rec: PcbRawRecord, storage: string, m: Masks): void {
  const others = (info.get(rec)?.ExtendedPrimitiveInformation ?? []).filter((x) => (x.get('TYPE') ?? '').toLowerCase() !== 'mask');
  const entries = [...others];
  if (m.solder.mode !== 'None' || m.paste.mode !== 'None') {
    const kv: [string, string][] = [['PRIMITIVEINDEX', '0'], ['PRIMITIVEOBJECTID', OBJECT_OF.get(storage) ?? 'Track'], ['TYPE', 'Mask']];
    kv.push(['SOLDERMASKEXPANSIONMODE', m.solder.mode]);
    if (m.solder.mode === 'Manual') kv.push(['SOLDERMASKEXPANSION_MANUAL', m.solder.value]);
    kv.push(['PASTEMASKEXPANSIONMODE', m.paste.mode]);
    if (m.paste.mode === 'Manual') kv.push(['PASTEMASKEXPANSION_MANUAL', m.paste.value]);
    entries.unshift(PropertyBag.fromEntries(kv));
  }
  setPrimInfo(rec, 'ExtendedPrimitiveInformation', entries.length ? entries : null);
}

/* ─── Konium's own pad settings (ExtendedPrimitiveInformation TYPE=KoniumPad [est]) ─────── */

/**
 * What a pad has that Konium can't place in AD's Pads6 record (AD keeps them there, where Konium
 * doesn't know): the bottom solder mask expansion when it isn't linked to the top, and the
 * solder mask opening measured from the hole's edge. An entry AD doesn't know the TYPE of [est].
 */
export interface PadExtras { bottom?: string; fromHoleEdge?: boolean }
export function padExtrasOf(rec: PcbRawRecord): PadExtras {
  const b = info.get(rec)?.ExtendedPrimitiveInformation?.find((x) => PAD_TYPES.includes(x.get('TYPE') ?? ''));
  if (!b) return {};
  return { ...(b.has('SOLDERMASKEXPANSION_BOTTOM') ? { bottom: b.get('SOLDERMASKEXPANSION_BOTTOM') } : {}), ...(b.bool('SOLDERMASKFROMHOLEEDGE') ? { fromHoleEdge: true } : {}) };
}
export function setPadExtras(rec: PcbRawRecord, x: PadExtras, object: 'Pad' | 'Via' = 'Pad'): void {
  const others = (info.get(rec)?.ExtendedPrimitiveInformation ?? []).filter((b) => !PAD_TYPES.includes(b.get('TYPE') ?? ''));
  const kv: [string, string][] = [['PRIMITIVEINDEX', '0'], ['PRIMITIVEOBJECTID', object], ['TYPE', 'KoniumPad']];
  if (x.bottom !== undefined) kv.push(['SOLDERMASKEXPANSION_BOTTOM', x.bottom]);
  if (x.fromHoleEdge) kv.push(['SOLDERMASKFROMHOLEEDGE', 'TRUE']);
  const entries = kv.length > 3 ? [...others, PropertyBag.fromEntries(kv)] : others;
  setPrimInfo(rec, 'ExtendedPrimitiveInformation', entries.length ? entries : null);
}
