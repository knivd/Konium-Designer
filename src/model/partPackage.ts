/**
 * A part as the parts library keeps one (R21): one exact orderable part number with its
 * schematic symbol, its footprint (with its 3D body) and what is known of it: its maker, its
 * package, its pins, and the datasheet it was made from (the link, the fingerprint and the pages
 * the pins and the package were read from, never the datasheet itself).
 *
 * A part travels as one file (a zip: part.json, symbol.SchLib, footprint.PcbLib): what the shelf
 * in this browser keeps, what Export Part File writes, and what the world library will hold. The
 * libraries inside are ordinary ones, so a part also goes out as an integrated library the
 * desktop software opens.
 *
 * The shelf's parts together make two libraries (My Parts.SchLib, My Parts.PcbLib) kept among
 * the installed ones, so Place › Part, the Libraries panel and a board's update find them like
 * any other.
 */
import { PropertyBag } from '../formats/altium/props';
import { SR } from './sch';
import { readSchLib, writeSchLib } from '../formats/altium/schlib';
import { readPcbLib, storageFor, writePcbLib, type FootprintDef } from '../formats/altium/pcblib';
import { decodePrim } from '../formats/altium/pcbdoc';
import type { PcbRawRecord } from '../formats/altium/framing';
import { packIntLib } from '../formats/altium/intlib';
import { zip } from '../formats/zip';
import { unzipSync } from '../formats/inflate';
import { partKey, partName } from './partKey';
import { readEntry, type LibraryEntry } from './worldLibrary';

export const PART_FORMAT = 1;
/** A part file's extension, and the names of what it holds. */
export const PART_EXT = '.kpart';
const RECORD_FILE = 'part.json', SYMBOL_FILE = 'symbol.SchLib', FOOTPRINT_FILE = 'footprint.PcbLib';
/** The shelf's two libraries among the installed ones. */
export const SHELF_SCH = 'My Parts.SchLib', SHELF_PCB = 'My Parts.PcbLib';

export interface PartPin { number: string; name: string; type: string }
export interface PartRecord {
  format: number;
  /** The exact orderable part number, as its maker writes it. */
  mpn: string;
  maker: string;
  /** The device its datasheet is about (the family the part number belongs to). */
  device: string;
  description: string;
  /** The package as the maker names it, its pin count (pads with a pin), the footprint's name and where its pads came from. */
  package: { name: string; pins: number; footprint: string; from: 'datasheet' | 'ipc' | 'drawn' };
  /** The symbol's name in its library (the part number). */
  symbol: string;
  pins: PartPin[];
  /** Where it was read from: the link ('' for a file given by hand), the PDF's SHA-256, and the pages read. */
  datasheet: { url: string; title: string; sha256: string; pages: number; pinPages: number[]; packagePages: number[] };
  /** When it was made (ISO), by which build, and how. */
  made: { at: string; app: string; by: string };
  /** In the world library: its note there, as it stood when this copy was fetched or published. Absent: a part of one's own, not published. */
  library?: LibraryEntry;
}
export interface PartPackage { record: PartRecord; schlib: Uint8Array; pcblib: Uint8Array }

export { partKey, partName } from './partKey';

export interface SymbolDef { libRef: string; description?: string; parts?: number; bags: PropertyBag[] }

const param = (name: string, text: string): PropertyBag => PropertyBag.from({ RECORD: SR.PARAMETER, OWNERPARTID: -1, NAME: name, TEXT: text, ISHIDDEN: true, FONTID: 1 });
const isParam = (b: PropertyBag, name: string) => b.int('RECORD', -1) === SR.PARAMETER && (b.get('NAME') ?? '').toLowerCase() === name.toLowerCase();
/** The footprints a symbol links, by name. */
export const linkedFootprints = (bags: PropertyBag[]): string[] => bags.filter((b) => b.int('RECORD', -1) === SR.IMPLEMENTATION && (b.get('MODELTYPE') ?? '').toUpperCase() === 'PCBLIB').map((b) => b.get('MODELNAME') ?? '').filter(Boolean);

export interface PartInput {
  mpn: string; maker: string; device: string; description: string;
  packageName: string; from: PartRecord['package']['from'];
  /** The symbol as built (named after the part, linked to the footprint by its name) and the footprint. */
  symbol: SymbolDef; footprint: FootprintDef;
  pins: PartPin[];
  datasheet: PartRecord['datasheet'];
  app: string; by: string; at?: Date;
}

/**
 * One part from a symbol and a footprint. The symbol takes what a bill of materials and a
 * supplier search read from a part (Manufacturer, Manufacturer Part Number, Package, and the
 * datasheet as its first component link), added after its records so their places stay.
 */
export function makePart(o: PartInput): PartPackage {
  const mpn = o.mpn.trim();
  const bags = o.symbol.bags.map((b) => b.clone());
  const set = (name: string, text: string) => { if (!text) return; const had = bags.find((b) => isParam(b, name)); if (had) had.set('TEXT', text); else bags.push(param(name, text)); };
  set('Manufacturer', o.maker);
  set('Manufacturer Part Number', mpn);
  set('Package', o.packageName);
  if (o.datasheet.url) { set('ComponentLink1Description', 'Datasheet'); set('ComponentLink1URL', o.datasheet.url); }
  // (the symbol is the one named: its own record says so too)
  if (bags[0] && bags[0].get('LIBREFERENCE') !== o.symbol.libRef) { bags[0].set('LIBREFERENCE', o.symbol.libRef); bags[0].set('DESIGNITEMID', o.symbol.libRef); }
  const symbol: SymbolDef = { ...o.symbol, bags };
  const pads = padNames(o.footprint.records);
  const record: PartRecord = {
    format: PART_FORMAT, mpn, maker: o.maker.trim(), device: o.device.trim(), description: o.description.trim(),
    package: { name: o.packageName.trim(), pins: new Set(pads).size, footprint: o.footprint.name, from: o.from },
    symbol: o.symbol.libRef, pins: o.pins.map((p) => ({ number: p.number, name: p.name, type: p.type })),
    datasheet: { ...o.datasheet, pinPages: [...o.datasheet.pinPages], packagePages: [...o.datasheet.packagePages] },
    made: { at: (o.at ?? new Date()).toISOString(), app: o.app, by: o.by },
  };
  return { record, schlib: writeSchLib([symbol]), pcblib: writePcbLib([o.footprint], `${partName(mpn)}.PcbLib`) };
}

/** The names of a footprint's pads, as its records have them. */
export const padNames = (records: PcbRawRecord[]): string[] =>
  records.map((r, i) => decodePrim(storageFor(r.tag), r, i, new Map())).flatMap((p) => (p?.kind === 'pad' ? [p.name] : []));

const symbolsOf = new WeakMap<Uint8Array, SymbolDef[]>();
const footprintsOf = new WeakMap<Uint8Array, FootprintDef[]>();
/** A part's symbol and footprint, read from its libraries (once for each). */
export function partSymbol(p: PartPackage): SymbolDef | null {
  let s = symbolsOf.get(p.schlib);
  if (!s) { try { s = readSchLib(p.schlib, SYMBOL_FILE).symbols.map((x) => ({ libRef: x.libRef, description: x.description, parts: x.parts, bags: x.bags })); } catch { s = []; } symbolsOf.set(p.schlib, s); }
  return s[0] ?? null;
}
export function partFootprint(p: PartPackage): FootprintDef | null {
  let f = footprintsOf.get(p.pcblib);
  if (!f) { try { f = readPcbLib(p.pcblib, FOOTPRINT_FILE).footprints.map((x) => ({ name: x.name, description: x.description, height: x.height, records: x.records })); } catch { f = []; } footprintsOf.set(p.pcblib, f); }
  return f[0] ?? null;
}

export interface PartCheck { level: 'error' | 'warning' | 'note'; text: string }
const byNumber = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
const some = (list: string[]) => `${list.sort(byNumber).slice(0, 10).join(', ')}${list.length > 10 ? ' …' : ''}`;

/**
 * What can be checked of a part without its datasheet: it has a symbol and a footprint, the
 * symbol links that footprint, every pin has its pad and every pad its pin, no pin number is used
 * twice, and it says where it was read from. (Whether the pins are the datasheet's is the
 * author's check, and later other people's.)
 */
export function partChecks(p: PartPackage): PartCheck[] {
  const out: PartCheck[] = [];
  const sym = partSymbol(p), fp = partFootprint(p);
  if (!sym) out.push({ level: 'error', text: 'No schematic symbol could be read from it' });
  if (!fp) out.push({ level: 'error', text: 'No footprint could be read from it' });
  if (!sym || !fp) return out;
  const pins = sym.bags.filter((b) => b.int('RECORD', -1) === SR.PIN).map((b) => b.get('DESIGNATOR') ?? '');
  const pads = [...new Set(padNames(fp.records))];
  const twice = pins.filter((n, i) => pins.indexOf(n) !== i);
  if (twice.length) out.push({ level: 'error', text: `Pin numbers used twice: ${some([...new Set(twice)])}` });
  const noPad = pins.filter((n) => !pads.includes(n)), noPin = pads.filter((n) => !pins.includes(n));
  if (noPad.length) out.push({ level: 'error', text: `Pins with no pad in the footprint: ${some(noPad)}` });
  if (noPin.length) out.push({ level: 'warning', text: `Pads with no pin in the symbol: ${some(noPin)}` });
  if (!noPad.length && !noPin.length && !twice.length) out.push({ level: 'note', text: `Every one of its ${pins.length} pins has its pad, and every pad its pin` });
  const linked = linkedFootprints(sym.bags);
  if (!linked.includes(fp.name)) out.push({ level: 'error', text: linked.length ? `The symbol links the footprint ${linked[0]}, not ${fp.name}` : 'The symbol links no footprint' });
  if (!p.record.datasheet.sha256) out.push({ level: 'warning', text: 'It doesn\'t say which datasheet it was read from' });
  else if (!p.record.datasheet.url) out.push({ level: 'warning', text: 'Its datasheet was a file given by hand: it has no link to it' });
  return out;
}

/* ─── The part file ───────────────────────────────────────────────────────────────────── */

/** A part as one file. */
export function partFile(p: PartPackage): Uint8Array {
  return zip([
    { name: RECORD_FILE, bytes: new TextEncoder().encode(`${JSON.stringify(p.record, null, 1)}\n`) },
    { name: SYMBOL_FILE, bytes: p.schlib },
    { name: FOOTPRINT_FILE, bytes: p.pcblib },
  ]);
}

const str = (v: unknown, max = 400): string => (typeof v === 'string' ? v.slice(0, max) : '');
const nums = (v: unknown): number[] => (Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n) && n > 0).slice(0, 60) : []);

/** A part file read: its record put in order (what it doesn't say stays empty); an error when it isn't one. */
export function readPartFile(bytes: Uint8Array): PartPackage {
  let files: { name: string; bytes: Uint8Array }[];
  try { files = unzipSync(bytes); } catch { throw new Error('Not a part file'); }
  const get = (n: string) => files.find((f) => f.name === n)?.bytes;
  const json = get(RECORD_FILE), schlib = get(SYMBOL_FILE), pcblib = get(FOOTPRINT_FILE);
  if (!json || !schlib || !pcblib) throw new Error('Not a part file: it holds no part.json with a symbol and a footprint');
  return readPartPieces(json, schlib, pcblib);
}

/** The same from its three pieces (as the world library keeps them): the record's text, the symbol's library, the footprint's. */
export function readPartPieces(json: Uint8Array, schlib: Uint8Array, pcblib: Uint8Array): PartPackage {
  let r: Record<string, unknown>;
  try { r = JSON.parse(new TextDecoder().decode(json)) as Record<string, unknown>; } catch { throw new Error('Not a part file: its record can\'t be read'); }
  if (typeof r.format !== 'number' || r.format > PART_FORMAT) throw new Error('This part file is from a later Konium Designer');
  const mpn = str(r.mpn, 80).trim();
  if (!partKey(mpn)) throw new Error('This part file names no part number');
  const pk = (r.package ?? {}) as Record<string, unknown>, ds = (r.datasheet ?? {}) as Record<string, unknown>, md = (r.made ?? {}) as Record<string, unknown>;
  const from = pk.from === 'datasheet' || pk.from === 'ipc' || pk.from === 'drawn' ? pk.from : 'drawn';
  const record: PartRecord = {
    format: PART_FORMAT, mpn, maker: str(r.maker, 120), device: str(r.device, 120), description: str(r.description),
    package: { name: str(pk.name, 120), pins: Number.isInteger(pk.pins) ? (pk.pins as number) : 0, footprint: str(pk.footprint, 120), from },
    symbol: str(r.symbol, 120),
    pins: (Array.isArray(r.pins) ? r.pins : []).slice(0, 4000).map((p) => { const x = (p ?? {}) as Record<string, unknown>; return { number: str(x.number, 16), name: str(x.name, 80), type: str(x.type, 24) }; }),
    datasheet: { url: /^https?:\/\//i.test(str(ds.url, 600)) ? str(ds.url, 600) : '', title: str(ds.title), sha256: /^[0-9a-f]{64}$/.test(str(ds.sha256)) ? str(ds.sha256) : '', pages: Number.isInteger(ds.pages) ? (ds.pages as number) : 0, pinPages: nums(ds.pinPages), packagePages: nums(ds.packagePages) },
    made: { at: str(md.at, 40), app: str(md.app, 20), by: str(md.by, 60) },
  };
  const entry = readEntry(r.library);
  if (entry && entry.key === partKey(mpn)) record.library = entry;
  const p: PartPackage = { record, schlib, pcblib };
  if (!partSymbol(p) || !partFootprint(p)) throw new Error('This part file\'s symbol or footprint can\'t be read');
  return p;
}

/** A part as an integrated library (its symbol's library and its footprint's, as Make Integrated Library packs them). */
export const partIntLib = (p: PartPackage): Promise<Uint8Array> => packIntLib([{ kind: 'SchLib', bytes: p.schlib }, { kind: 'PcbLib', bytes: p.pcblib }]);

/* ─── The shelf as two libraries ──────────────────────────────────────────────────────── */

function sameRecords(a: PcbRawRecord[], b: PcbRawRecord[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((r, i) => r.tag === b[i]!.tag && r.subs.length === b[i]!.subs.length && r.subs.every((s, k) => { const t = b[i]!.subs[k]!; return s.length === t.length && s.every((v, n) => v === t[n]); }));
}

/**
 * The shelf's parts as one schematic library and one PCB library. Parts of one package share its
 * footprint; two footprints of one name that differ (the same package read from two datasheets)
 * both stay, the later one under its name with the part number, and its symbol links that.
 */
export function shelfLibraries(parts: PartPackage[]): { schlib: Uint8Array; pcblib: Uint8Array; symbols: number; footprints: number } {
  const symbols: SymbolDef[] = [], footprints: FootprintDef[] = [];
  const taken = new Set<string>();
  for (const p of parts) {
    const sym = partSymbol(p), fp = partFootprint(p);
    if (!sym || !fp) continue;
    let fpName = fp.name;
    const had = footprints.find((f) => f.name.toLowerCase() === fp.name.toLowerCase());
    if (!had) footprints.push(fp);
    else if (!sameRecords(had.records, fp.records)) {
      fpName = `${fp.name} (${partName(p.record.mpn)})`;
      if (!footprints.some((f) => f.name.toLowerCase() === fpName.toLowerCase())) footprints.push({ ...fp, name: fpName });
    }
    let libRef = sym.libRef, k = 2;
    while (taken.has(libRef.toLowerCase())) libRef = `${sym.libRef} (${k++})`;
    taken.add(libRef.toLowerCase());
    const bags = sym.bags.map((b) => b.clone());
    if (libRef !== sym.libRef) { bags[0]!.set('LIBREFERENCE', libRef); bags[0]!.set('DESIGNITEMID', libRef); }
    if (fpName !== fp.name) for (const b of bags) if (b.int('RECORD', -1) === SR.IMPLEMENTATION && b.get('MODELNAME') === fp.name) { b.set('MODELNAME', fpName); b.set('MODELDATAFILEENTITY0', fpName); }
    symbols.push({ ...sym, libRef, bags });
  }
  return { schlib: writeSchLib(symbols), pcblib: writePcbLib(footprints, SHELF_PCB), symbols: symbols.length, footprints: footprints.length };
}
