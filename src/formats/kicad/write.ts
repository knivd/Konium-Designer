/**
 * What the KiCad writers share: the file versions written (KiCad 8's, which KiCad 8 and later
 * read), deterministic UUIDs (the same design exports the same files), millimetres from AD's
 * units, AD's text conventions in KiCad's (overbars, net-name slashes) and names KiCad takes
 * for libraries and their items.
 */
import { bare, type Bare } from './sexpr';
import { APP_VERSION } from '../../platform/distribution';

export const SCH_VERSION = 20231120;
export const PCB_VERSION = 20240108;
export const SYM_VERSION = 20231120;
export const GENERATOR = 'konium';
export const generatorVersion = (): string => APP_VERSION;

/** mm per AD unit (1/10000 mil). */
export const UMM = 25.4 / 1e7;
export const r4 = (v: number): number => { const r = Math.round(v * 1e4) / 1e4; return Object.is(r, -0) ? 0 : r; };
export const r6 = (v: number): number => { const r = Math.round(v * 1e6) / 1e6; return Object.is(r, -0) ? 0 : r; };
export const yes = (b: boolean): Bare => bare(b ? 'yes' : 'no');

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** A UUID from a seed (128 bits of four mixed 32-bit hashes, marked version 4); a seed that is a UUID (one kept from KiCad) is itself. */
export function kuuid(seed: string): string {
  if (UUID.test(seed)) return seed;
  const h = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35];
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    for (let k = 0; k < 4; k++) h[k] = Math.imul(h[k]! ^ c, 0x01000193 + k * 0x2f);
  }
  for (let k = 0; k < 4; k++) {
    let x = h[k]! ^ seed.length ^ (k * 0x27d4eb2f);
    x = Math.imul(x ^ (x >>> 16), 0x85ebca6b); x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35); x ^= x >>> 16;
    h[k] = x >>> 0;
  }
  const hex = h.map((v) => v.toString(16).padStart(8, '0')).join('');
  const v = (parseInt(hex[16]!, 16) & 0x3 | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${v}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** AD's overbars (a backslash after each barred character: R\S\T\) as KiCad's ~{RST}. */
export function kicadMarkup(s: string): string {
  let out = '', bar = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '\\') continue;
    if (s[i + 1] === '\\') { bar += c; continue; }
    if (bar) { out += `~{${bar}}`; bar = ''; }
    out += c;
  }
  return bar ? `${out}~{${bar}}` : out;
}
/** A net's name as KiCad keeps it in labels ('/' is its sheet-path separator). */
export const kicadNet = (s: string): string => kicadMarkup(s).replace(/\//g, '{slash}');
/** A library item's or library's name: no ':' or '/', nothing KiCad's file names refuse. */
export const kicadName = (s: string): string => s.trim().replace(/[:/\\*?"<>|]/g, '_') || '_';

/** Messages counted by kind (one line each, with how many). */
export class Tally {
  private m = new Map<string, number>();
  add(what: string, n = 1): void { this.m.set(what, (this.m.get(what) ?? 0) + n); }
  lines(): string[] { return [...this.m].map(([k, n]) => (n > 1 ? `${k} (${n})` : k)); }
}
