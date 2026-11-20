/**
 * The world parts library (R21, step 2): what the app and the library's service
 * (cloudflare/library) agree on. A part is published as four files in one folder of a public Git
 * repository: its record (part.json), its symbol's library, its footprint's library (with its
 * 3D body), and the library's own note about it (library.json: who published it, when, which
 * revision, its standing). Everything in the library is given to the public domain (CC0 1.0).
 *
 * Nothing here reads a library file: the service checks a record's text and passes the two
 * library files on unread; the app that fetches a part reads and checks it before offering it.
 */
import { partKey } from './partKey';
import type { PartRecord } from './partPackage';

export const LIBRARY_LICENCE = 'CC0-1.0';
export const LICENCE_NAME = 'CC0 1.0 Universal';
export const LICENCE_URL = 'https://creativecommons.org/publicdomain/zero/1.0/';

/**
 * A part's standing in the library. Unverified: published, and looked at by nobody but its
 * author. Confirmed and proven come with the approval step (others have checked it against the
 * datasheet; it has been built on a board).
 */
export type PartStatus = 'unverified' | 'confirmed' | 'proven';
export const STATUS_NAMES: Record<PartStatus, string> = { unverified: 'Unverified', confirmed: 'Confirmed', proven: 'Proven' };

/** The library's note about a part (library.json beside it). */
export interface LibraryEntry {
  key: string;
  mpn: string;
  status: PartStatus;
  /** Who published it: a contributor number (k- and eight hex digits), never an address. */
  by: string;
  /** The name the contributor chose to show ('' for none). */
  name: string;
  /** When this revision was published (ISO). */
  published: string;
  revision: number;
  licence: string;
  /** The build that published it. */
  app: string;
}

export const RECORD_FILE = 'part.json', ENTRY_FILE = 'library.json', SYMBOL_FILE = 'symbol.SchLib', FOOTPRINT_FILE = 'footprint.PcbLib';
export type LibraryFile = typeof RECORD_FILE | typeof SYMBOL_FILE | typeof FOOTPRINT_FILE;
export const LIBRARY_FILES: LibraryFile[] = [RECORD_FILE, SYMBOL_FILE, FOOTPRINT_FILE];
/** The most each may come to, in bytes. */
export const MAX_RECORD = 200 * 1024, MAX_SYMBOL = 400 * 1024, MAX_FOOTPRINT = 1024 * 1024;

/** A key the library takes: three characters at least. */
export const KEY_FORMAT = /^[A-Z0-9]{3,80}$/;
/** Where a part lives in the repository: parts/<the first two characters of its key>/<its key>. */
export const partFolder = (key: string): string => `parts/${key.slice(0, 2)}/${key}`;
/** A contributor's number as shown. */
export const CONTRIBUTOR = /^k-[0-9a-f]{8}$/;

/** The name a contributor shows with their parts: letters, digits and a few marks, 40 characters at most. */
export const shownName = (s: unknown): string => (typeof s === 'string' ? s.replace(/[^\p{L}\p{N} .,'_-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 40) : '');
/** An address as it is compared, or '' when it isn't one. */
export function mailAddress(s: unknown): string {
  const a = typeof s === 'string' ? s.trim().toLowerCase() : '';
  return a.length <= 254 && /^[^\s@<>()[\]\\,;:"]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(a) ? a : '';
}

const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** The library's note about a part, put in order; null when it isn't one. */
export function readEntry(v: unknown): LibraryEntry | null {
  const e = obj(v);
  if (!text(e.key, 80) || !KEY_FORMAT.test(e.key) || !text(e.mpn, 80) || partKey(e.mpn) !== e.key) return null;
  const status: PartStatus = e.status === 'confirmed' || e.status === 'proven' ? e.status : 'unverified';
  return {
    key: e.key, mpn: e.mpn, status, by: text(e.by, 10) && CONTRIBUTOR.test(e.by) ? e.by : '', name: shownName(e.name),
    published: text(e.published, 40) ? e.published : '', revision: Number.isInteger(e.revision) && (e.revision as number) > 0 ? e.revision as number : 1,
    licence: text(e.licence, 40) ? e.licence : LIBRARY_LICENCE, app: text(e.app, 20) ? e.app : '',
  };
}

/**
 * What stops a record from being published, each in words for its author (none: it may go). The
 * record's own text only: that the pins match the pads is the app's check before it sends, and
 * again every app's that fetches the part.
 */
export function recordProblems(r: unknown): string[] {
  const out: string[] = [];
  const rec = obj(r), pk = obj(rec.package), ds = obj(rec.datasheet), made = obj(rec.made);
  if (typeof rec.format !== 'number' || rec.format < 1) out.push('It is not a part record');
  if (!text(rec.mpn, 80) || !KEY_FORMAT.test(partKey(rec.mpn))) out.push('Its part number must have three letters or digits at least, and 80 characters at most');
  if (!text(rec.maker, 120) || !rec.maker.trim()) out.push('It names no manufacturer');
  if (!text(rec.device, 120)) out.push('Its device name is too long');
  if (!text(rec.description, 400)) out.push('Its description is too long');
  if (!text(rec.symbol, 120) || !rec.symbol) out.push('It names no symbol');
  if (!text(pk.name, 120) || !pk.name.trim()) out.push('It names no package');
  if (!text(pk.footprint, 120) || !pk.footprint) out.push('It names no footprint');
  if (!Number.isInteger(pk.pins) || (pk.pins as number) < 1 || (pk.pins as number) > 4000) out.push('Its package has no pin count');
  if (pk.from !== 'datasheet' && pk.from !== 'ipc' && pk.from !== 'drawn') out.push('It doesn\'t say where its footprint came from');
  const pins = Array.isArray(rec.pins) ? rec.pins : null;
  if (!pins || !pins.length || pins.length > 4000) out.push('It lists no pins');
  else if (!pins.every((p) => { const x = obj(p); return text(x.number, 16) && !!x.number && text(x.name, 80) && text(x.type, 24); })) out.push('One of its pins has no number, or a name too long');
  if (!text(ds.url, 600) || (ds.url !== '' && !/^https?:\/\/[^\s<>"']+$/i.test(ds.url))) out.push('Its datasheet\'s link is not a web address');
  if (!text(ds.title, 400)) out.push('Its datasheet\'s title is too long');
  if (!text(ds.sha256, 64) || (ds.sha256 !== '' && !/^[0-9a-f]{64}$/.test(ds.sha256))) out.push('Its datasheet\'s fingerprint is not one');
  if (!text(made.at, 40) || !text(made.app, 20) || !text(made.by, 60)) out.push('It doesn\'t say how it was made');
  return out;
}

/** Text on one line: line breaks, tabs and control characters become a space, runs of spaces one. */
export const oneLine = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/ {2,}/g, ' ').trim();
/**
 * A value as it goes into a commit's message: on one line, and with the two marks a repository's
 * site reads as a reference (to a person, to an issue) written in their wide forms, so that a
 * part's fields can name nobody and close nothing. The record itself keeps them as they are.
 */
export const forMessage = (s: string): string => oneLine(s).replace(/@/g, '\uFF20').replace(/#/g, '\uFF03').slice(0, 120);
const str = (v: unknown, max: number): string => (typeof v === 'string' ? oneLine(v).slice(0, max) : '');
const pages = (v: unknown): number[] => (Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n) && n > 0).slice(0, 60) : []);

/**
 * A record as the library keeps it: the fields a part record has and nothing else (whatever more
 * was sent is dropped), each text on one line (no line breaks or control characters), and without
 * the library's own note, which is library.json's to say. Call it on a record that has no
 * problems (recordProblems).
 */
export function cleanRecord(r: unknown): PartRecord {
  const rec = obj(r), pk = obj(rec.package), ds = obj(rec.datasheet), made = obj(rec.made);
  return {
    format: 1, mpn: str(rec.mpn, 80), maker: str(rec.maker, 120), device: str(rec.device, 120), description: str(rec.description, 400),
    package: { name: str(pk.name, 120), pins: Number(pk.pins) || 0, footprint: str(pk.footprint, 120), from: pk.from === 'datasheet' || pk.from === 'ipc' ? pk.from : 'drawn' },
    symbol: str(rec.symbol, 120),
    pins: (Array.isArray(rec.pins) ? rec.pins : []).slice(0, 4000).map((p) => { const x = obj(p); return { number: str(x.number, 16), name: str(x.name, 80), type: str(x.type, 24) }; }),
    datasheet: { url: str(ds.url, 600), title: str(ds.title, 400), sha256: str(ds.sha256, 64), pages: Number.isInteger(ds.pages) ? ds.pages as number : 0, pinPages: pages(ds.pinPages), packagePages: pages(ds.packagePages) },
    made: { at: str(made.at, 40), app: str(made.app, 20), by: str(made.by, 60) },
  };
}

