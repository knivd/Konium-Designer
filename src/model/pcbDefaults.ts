/**
 * Primitive defaults, as AD17 keeps them (Preferences › PCB Editor › Defaults, Tab while
 * placing): a whole record per kind that the next object of that kind starts from — its mask
 * expansions, tenting, testpoints, font and the rest, not only its size. Kept between sessions
 * in this browser; "Permanent" keeps Tab's changes to the session.
 */
import type { PcbRawRecord } from '../formats/altium/framing';
import { carryPrimInfo, masksOf, primInfo, setMasks, setPrimInfo, type Masks } from '../formats/altium/primInfo';
import { exportBagDefaults, importBagDefaults } from './bagDefaults';

export type DefaultStorage = 'Arcs6' | 'Fills6' | 'Pads6' | 'Texts6' | 'Tracks6' | 'Vias6' | 'Regions6';
export const DEFAULT_KINDS: [DefaultStorage, string][] = [
  ['Arcs6', 'Arc'], ['Fills6', 'Fill'], ['Pads6', 'Pad'], ['Regions6', 'Region'], ['Texts6', 'String'], ['Tracks6', 'Track'], ['Vias6', 'Via'],
];

const KEY = 'konium.pcbDefaults';
const saved = new Map<string, PcbRawRecord>();
const session = new Map<string, PcbRawRecord>();
let loaded = false;

const b64 = (b: Uint8Array) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return;
    const o = JSON.parse(raw) as Record<string, { tag: number; subs: string[]; masks?: Masks }>;
    for (const [k, v] of Object.entries(o)) {
      const rec: PcbRawRecord = { tag: v.tag, subs: v.subs.map(unb64) };
      if (v.masks) setMasks(rec, k, v.masks);
      saved.set(k, rec);
    }
  } catch { /* storage unavailable or damaged: start from AD17's */ }
}
function store(): void {
  try {
    const o: Record<string, { tag: number; subs: string[]; masks: Masks }> = {};
    for (const [k, r] of saved) o[k] = { tag: r.tag, subs: r.subs.map(b64), masks: masksOf(r) };
    globalThis.localStorage?.setItem(KEY, JSON.stringify(o));
  } catch { /* not kept */ }
}

/** A copy with the mask expansions but never a unique ID (each pad gets its own). */
const copy = (r: PcbRawRecord): PcbRawRecord => {
  const c = { tag: r.tag, subs: r.subs.map((s) => s.slice()) };
  carryPrimInfo(r, c);
  if (primInfo(c)?.UniqueIDPrimitiveInformation) setPrimInfo(c, 'UniqueIDPrimitiveInformation', null);
  return c;
};

/** The record the next object of this kind starts from: Tab's for this session, else the saved default. */
export function primDefault(storage: string): PcbRawRecord | undefined {
  load();
  const r = session.get(storage) ?? saved.get(storage);
  return r && copy(r);
}

/** Tab while placing: the next ones start from this (kept as the default unless Permanent). */
export function setTabDefault(storage: string, rec: PcbRawRecord, permanent: boolean): void {
  load();
  session.set(storage, copy(rec));
  if (!permanent) { saved.set(storage, copy(rec)); store(); }
}

/** Preferences › Defaults › Edit Values: the saved default. */
export function setSavedDefault(storage: string, rec: PcbRawRecord): void {
  load();
  saved.set(storage, copy(rec));
  session.delete(storage);
  store();
}

/** Reset: back to AD17's (one kind, or all). */
export function resetDefaults(storage?: string): void {
  load();
  if (storage) { saved.delete(storage); session.delete(storage); } else { saved.clear(); session.clear(); }
  store();
}

/** Has this kind a default of its own (not AD17's)? */
export const hasDefault = (storage: string): boolean => { load(); return saved.has(storage) || session.has(storage); };

/** Save As / Load: the defaults as a file of their own (Konium's .json [est: AD17's .DFT is binary]). */
export function exportDefaults(): string {
  load();
  const o: Record<string, { tag: number; subs: string[]; masks: Masks }> = {};
  for (const [k, r] of saved) o[k] = { tag: r.tag, subs: r.subs.map(b64), masks: masksOf(r) };
  return JSON.stringify({ format: 'konium-pcb-defaults', version: 1, defaults: o, bags: exportBagDefaults() }, null, 1);
}
export function importDefaults(text: string): number {
  const o = JSON.parse(text) as { format?: string; defaults?: Record<string, { tag: number; subs: string[]; masks?: Masks }>; bags?: Record<string, Record<string, string>> };
  if (o.format !== 'konium-pcb-defaults' || !o.defaults) throw new Error('not a Konium Designer defaults file');
  load();
  let n = 0;
  for (const [k, v] of Object.entries(o.defaults)) {
    const rec: PcbRawRecord = { tag: v.tag, subs: v.subs.map(unb64) };
    if (v.masks) setMasks(rec, k, v.masks);
    saved.set(k, rec); session.delete(k); n++;
  }
  store();
  return n + importBagDefaults(o.bags);
}
