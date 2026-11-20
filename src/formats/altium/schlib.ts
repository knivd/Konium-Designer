/**
 * Altium schematic library (.SchLib): a compound file with
 *   FileHeader          — |HEADER=…Schematic Library Editor Binary File Version 5.0|COMPCOUNT=n|LIBREF0=…|COMPDESCR0=…|PARTCOUNT0=…
 *   SectionKeys         — long library references → storage names (optional)
 *   <storage>/Data      — one symbol: the COMPONENT record, then its graphics, pins, parameters and models
 * Pins in a library are binary records (header kind 1), laid out as documented by KiCad's
 * Altium importer; everything else is the same property text a schematic uses. Children own to
 * the component by position; implementation records nest (list → implementation → maps/params).
 */
import { BinReader, BinWriter } from '../bin';
import { cfbFind, cfbPut, newEntry, readCfb, writeCfb, type CfbEntry, type CfbFile } from '../cfb/cfb';
import { joinSchRecords, splitSchRecords, type SchRawRecord } from './framing';
import { PropertyBag } from './props';
import { ansiToStr, bytesToBin, binToBytes, codePageOfStreams, currentCodePage, toAnsiLossy, utf8ToBin, withCodePage } from '../text';
import { inflateRawSync } from '../inflate';
import { zlibStored } from './schdoc';
import { SR } from '../../model/sch';

export interface LibSymbol {
  libRef: string;
  description: string;
  /** Parts in the package (Altium stores PARTCOUNT as parts + 1). */
  parts: number;
  /** Compound-file storage holding it. */
  storage: string;
  /** The COMPONENT record first, then every child (pins converted to property records). */
  bags: PropertyBag[];
  /** Its Data stream as read: a symbol's records are parsed the first time `bags` is used. */
  raw?: Uint8Array;
  /** The header's AliasList for it, as read (kept on save while the symbol keeps its name). */
  aliases?: string;
}

export interface SchLibrary { name: string; header: PropertyBag; symbols: LibSymbol[]; cfb?: CfbFile }

/** Every record of a symbol's Data stream (library pins turned into property records, with their wide text). */
function parseBags(data: Uint8Array, wide?: Uint8Array): PropertyBag[] {
  const bags: PropertyBag[] = [];
  const texts = wide ? readPinWideText(wide) : null;
  let pin = 0;
  for (const rec of splitSchRecords(data)) {
    const bag = rec.bag ?? (rec.kind === 1 ? decodeBinaryPin(rec.data) : null);
    if (!bag) continue;
    if (bag.int('RECORD', -1) === SR.PIN) {
      const t = texts?.get(pin++);
      if (t) {
        // The pin's text beyond its code page (Ω, −, µ …), as %UTF8% twins: what it is read as, the record as it was
        for (const [k, v] of Object.entries(t)) bag.setRaw(`%UTF8%${WIDE_KEYS[k] ?? k}`, utf8ToBin(v));
        bag.modified = false;
      }
    }
    bags.push(bag);
  }
  return bags;
}

/* ─── PinWideText ────────────────────────────────────────────────────────────────────── */

/** PinWideText's keys → the pin's own. */
const WIDE_KEYS: Record<string, string> = { DESC: 'DESCRIPTION', NAME: 'NAME', DESIGNATOR: 'DESIGNATOR' };
/**
 * A symbol's PinWideText stream: what of its pins' text the 8-bit pin record can't hold. A
 * "|HEADER=PinWideText|Weight=n" record, then per pin (by its place among the symbol's pins) an
 * entry as the Storage stream's [checked against the desktop software's libraries]: 0xD0, the
 * pin's number as text, a u32 size, zlib data holding a u32 byte count and UTF-16 "|DESC=…|NAME=…".
 */
export function readPinWideText(st: Uint8Array): Map<number, Record<string, string>> {
  const out = new Map<number, Record<string, string>>();
  try {
    const dv = new DataView(st.buffer, st.byteOffset, st.byteLength);
    let at = 4 + (dv.getUint32(0, true) & 0xffffff);
    while (at + 6 <= st.length) {
      const len = dv.getUint32(at, true) & 0xffffff, end = at + 4 + len;
      let p = at + 5;
      const n = st[p]!;
      const which = Number(bytesToBin(st.subarray(p + 1, p + 1 + n)));
      p += 1 + n;
      const size = dv.getUint32(p, true);
      const raw = inflateRawSync(st.subarray(p + 4 + 2, p + 4 + size));
      const bytes = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(0, true);
      const text = new TextDecoder('utf-16le').decode(raw.subarray(4, 4 + bytes));
      const fields: Record<string, string> = {};
      for (const part of text.split('|')) { const eq = part.indexOf('='); if (eq > 0) fields[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1); }
      if (Number.isInteger(which)) out.set(which, fields);
      at = end;
    }
  } catch { /* what could be read */ }
  return out;
}
/** The PinWideText stream for a symbol's pins, when any has text beyond plain ASCII (null: none). */
export function writePinWideText(pins: PropertyBag[]): Uint8Array | null {
  const entries: { name: string; bytes: Uint8Array }[] = [];
  pins.forEach((b, k) => {
    const parts: string[] = [];
    for (const [w, key] of [['DESC', 'DESCRIPTION'], ['NAME', 'NAME'], ['DESIGNATOR', 'DESIGNATOR']] as const) { const v = b.get(key) ?? ''; if (/[^\x00-\x7f]/.test(v)) parts.push(`|${w}=${v}`); }
    if (!parts.length) return;
    const text = parts.join('');
    const body = new Uint8Array(4 + text.length * 2);
    const dv = new DataView(body.buffer);
    dv.setUint32(0, text.length * 2, true);
    for (let i = 0; i < text.length; i++) dv.setUint16(4 + i * 2, text.charCodeAt(i), true);
    entries.push({ name: String(k), bytes: body });
  });
  if (!entries.length) return null;
  // (the Storage stream's frame, under its own header)
  const u32 = (v: number) => new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
  const head = binToBytes(`|HEADER=PinWideText|Weight=${entries.length}\0`);
  const parts: Uint8Array[] = [u32(head.length), head];
  for (const e of entries) {
    const name = binToBytes(e.name), data = zlibStored(e.bytes);
    parts.push(u32((1 + 1 + name.length + 4 + data.length) | 0x01000000), new Uint8Array([0xd0, name.length]), name, u32(data.length), data);
  }
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}

/** True once a symbol's records have been parsed (or it was made in memory). */
export function symbolLoaded(s: LibSymbol): boolean {
  return !(s as { pending?: boolean }).pending;
}

/** How many records a symbol has, without parsing an untouched one. */
export function symbolRecordCount(s: LibSymbol): number {
  if (symbolLoaded(s) || !s.raw) return s.bags.length;
  let n = 0;
  for (let o = 0; o + 4 <= s.raw.length; n++) o += 4 + (new DataView(s.raw.buffer, s.raw.byteOffset + o, 4).getUint32(0, true) & 0x00ffffff);
  return n;
}

/**
 * A symbol read from a library: only its COMPONENT record is parsed now (name, description,
 * parts); the rest waits until something looks at `bags`, so libraries of thousands of
 * components open at once.
 */
function lazySymbol(storage: string, data: Uint8Array, wide?: Uint8Array): LibSymbol | null {
  if (data.length < 4) return null;
  // (the library's code page, for the records read later)
  const cp = currentCodePage();
  const h = new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true);
  if (h >>> 24 !== 0) return null;
  const comp = PropertyBag.parse(data.subarray(4, 4 + Math.min(h & 0x00ffffff, data.length - 4)));
  if (comp.int('RECORD', -1) !== SR.COMPONENT) return null;
  let bags: PropertyBag[] | null = null;
  const sym = {
    libRef: comp.get('LIBREFERENCE') ?? comp.get('DESIGNITEMID') ?? storage,
    description: comp.get('COMPONENTDESCRIPTION') ?? '',
    parts: Math.max(1, comp.int('PARTCOUNT', 2) - 1),
    storage,
    raw: data,
  } as LibSymbol;
  Object.defineProperty(sym, 'bags', {
    enumerable: true, configurable: true,
    get: () => { if (!bags) { bags = withCodePage(cp, () => parseBags(data, wide)); if (bags.length) bags[0] = comp; else bags = [comp]; } return bags; },
    set: (v: PropertyBag[]) => { bags = v; },
  });
  Object.defineProperty(sym, 'pending', { enumerable: false, configurable: true, get: () => !bags });
  return sym;
}

const HEADER = 'Protel for Windows - Schematic Library Editor Binary File Version 5.0';

/* ─── Binary pins ────────────────────────────────────────────────────────────────────── */

// Pin strings are 8-bit, in the file's code page, as the property records' are
function pascal(r: BinReader): string { const n = r.u8(); return ansiToStr(bytesToBin(r.bytes(Math.min(n, r.remaining))), currentCodePage()); }
function putPascal(w: BinWriter, s: string, cp: number): void { const b = binToBytes(toAnsiLossy(s, cp).slice(0, 255)); w.u8(b.length).bytes(b); }

/** A library pin record → the property form a schematic stores. */
export function decodeBinaryPin(data: Uint8Array): PropertyBag | null {
  try {
    const r = new BinReader(data);
    if (r.i32() !== SR.PIN) return null;
    r.u8();
    const owner = r.i16(), mode = r.u8(), innerEdge = r.u8(), outerEdge = r.u8(), inner = r.u8(), outer = r.u8();
    const description = pascal(r);
    r.u8();
    const electrical = r.u8(), conglomerate = r.u8(), length = r.i16(), x = r.i16(), y = r.i16(), color = r.i32();
    const name = pascal(r), designator = pascal(r), swap = pascal(r);
    const b = new PropertyBag();
    b.cp = currentCodePage();
    const set = (k: string, v: string | number, skipZero = true) => { if (v === '' || (skipZero && v === 0)) return; b.set(k, String(v)); };
    set('RECORD', SR.PIN); set('OWNERPARTID', owner, false); set('OWNERPARTDISPLAYMODE', mode);
    set('SYMBOL_INNEREDGE', innerEdge); set('SYMBOL_OUTEREDGE', outerEdge); set('SYMBOL_INNER', inner); set('SYMBOL_OUTER', outer);
    set('DESCRIPTION', description); set('ELECTRICAL', electrical); set('PINCONGLOMERATE', conglomerate); set('PINLENGTH', length);
    set('LOCATION.X', x); set('LOCATION.Y', y); set('COLOR', color); set('NAME', name); set('DESIGNATOR', designator); set('SWAPIDGROUP', swap);
    if (r.remaining) {
      const seq = pascal(r).split('|');
      if (seq.length === 3) { set('SWAPIDPART', seq[0]!); set('SWAPIDSEQUENCE', seq[2]!); }
    }
    return b;
  } catch {
    return null;
  }
}

/**
 * A library pin's swap group: the binary record carries one swap-group string (after the
 * designator; SWAPIDGROUP once read) and the part|&|sequence string, nothing else. On a sheet the
 * same group is SWAPIDPIN (schPlace), so a pin that came from a sheet may still carry it as that.
 */
export const libPinSwapGroup = (b: { get(k: string): string | undefined }): string => b.get('SWAPIDGROUP') || b.get('SWAPIDPIN') || '';

/** A pin's properties → Altium's binary library form. */
export function encodeBinaryPin(b: PropertyBag): Uint8Array {
  const w = new BinWriter(96);
  w.i32(SR.PIN).u8(0).i16(b.int('OWNERPARTID', 1)).u8(b.int('OWNERPARTDISPLAYMODE'));
  w.u8(b.int('SYMBOL_INNEREDGE')).u8(b.int('SYMBOL_OUTEREDGE')).u8(b.int('SYMBOL_INNER')).u8(b.int('SYMBOL_OUTER'));
  const cp = b.cp;
  putPascal(w, b.get('DESCRIPTION') ?? '', cp);
  w.u8(1).u8(b.int('ELECTRICAL')).u8(b.int('PINCONGLOMERATE')).i16(b.int('PINLENGTH')).i16(b.int('LOCATION.X')).i16(b.int('LOCATION.Y')).i32(b.int('COLOR'));
  putPascal(w, b.get('NAME') ?? '', cp); putPascal(w, b.get('DESIGNATOR') ?? '', cp); putPascal(w, libPinSwapGroup(b), cp);
  putPascal(w, `${b.get('SWAPIDPART') ?? ''}|&|${b.get('SWAPIDSEQUENCE') ?? ''}`, cp);
  // Altium ends the record with a NUL after the last string
  w.u8(0);
  return w.finish();
}

/* ─── Read ───────────────────────────────────────────────────────────────────────────── */

export function readSchLib(bytes: Uint8Array, name: string): SchLibrary {
  const cfb = readCfb(bytes);
  // Text without a %UTF8% twin is in the code page of the author's Windows (told from every symbol's records)
  const datas = cfb.root.children.filter((st) => st.kind === 'storage').map((st) => st.children?.find((c: CfbEntry) => c.name === 'Data' && c.kind === 'stream')?.data);
  return withCodePage(codePageOfStreams(cfbFind(cfb.root, 'FileHeader')?.data, ...datas), () => readSchLibIn(cfb, name));
}
function readSchLibIn(cfb: ReturnType<typeof readCfb>, name: string): SchLibrary {
  const { root } = cfb;
  const fh = cfbFind(root, 'FileHeader');
  if (!fh?.data) throw new Error(`${name}: no FileHeader`);
  const head = splitSchRecords(fh.data)[0]?.bag;
  if (!head || !/Schematic Library/i.test(head.get('HEADER') ?? '')) throw new Error(`${name}: not a schematic library Konium Designer can read`);
  const symbols: LibSymbol[] = [];
  for (const st of root.children) {
    if (st.kind !== 'storage') continue;
    const data = st.children?.find((c: CfbEntry) => c.name === 'Data' && c.kind === 'stream')?.data;
    if (!data) continue;
    const sym = lazySymbol(st.name, data, st.children?.find((c: CfbEntry) => c.name === 'PinWideText' && c.kind === 'stream')?.data);
    if (sym) symbols.push(sym);
  }
  // The header's order (Altium's list order), then anything it doesn't name; its descriptions where a component has none
  const order = new Map<string, number>(), descr = new Map<string, string>(), alias = new Map<string, string>();
  for (let i = 0, n = head.int('COMPCOUNT'); i < n; i++) {
    const ref = (head.get(`LIBREF${i}`) ?? '').toLowerCase();
    order.set(ref, i);
    const d = head.get(`COMPDESCR${i}`);
    if (d) descr.set(ref, d);
    const a = head.getRaw(`ALIASLIST${i}`);
    if (a) alias.set(ref, a);
  }
  for (const s of symbols) {
    if (!s.description) s.description = descr.get(s.libRef.toLowerCase()) ?? '';
    const a = alias.get(s.libRef.toLowerCase());
    if (a) s.aliases = a;
  }
  symbols.sort((a, b) => (order.get(a.libRef.toLowerCase()) ?? 1e9) - (order.get(b.libRef.toLowerCase()) ?? 1e9) || a.libRef.localeCompare(b.libRef));
  return { name, header: head, symbols, cfb };
}

/* ─── Write (Konium's own libraries: the demo, and new ones) ────────────────────── */

const storageOf = (libRef: string, taken: Set<string>) => {
  const base = libRef.replace(/[/\\:*?"<>|!]/g, '_').slice(0, 31) || 'Component';
  let s = base;
  for (let i = 1; taken.has(s.toLowerCase()); i++) s = `${base.slice(0, 27)}_${i}`;
  taken.add(s.toLowerCase());
  return s;
};

export function writeSchLib(symbols: { libRef: string; description?: string; parts?: number; bags: PropertyBag[] }[]): Uint8Array {
  const root = newEntry('Root Entry', 'root');
  const head = PropertyBag.from({ HEADER: HEADER, WEIGHT: symbols.reduce((n, s) => n + s.bags.length, 1), MINORVERSION: 2, FONTIDCOUNT: 1, SIZE1: 10, FONTNAME1: 'Times New Roman',
    USEMBCS: true, ISBOC: true, SHEETSTYLE: 9, BORDERON: true, SHEETNUMBERSPACESIZE: 12, AREACOLOR: 16317695, SNAPGRIDON: true, SNAPGRIDSIZE: 10,
    VISIBLEGRIDON: true, VISIBLEGRIDSIZE: 10, CUSTOMX: 18000, CUSTOMY: 18000, USECUSTOMSHEET: true, REFERENCEZONESON: true, DISPLAY_UNIT: 4, COMPCOUNT: symbols.length });
  const taken = new Set<string>();
  const keys: string[] = [];
  symbols.forEach((s, i) => {
    head.set(`LIBREF${i}`, s.libRef);
    if (s.description) head.set(`COMPDESCR${i}`, s.description);
    head.set(`PARTCOUNT${i}`, String((s.parts ?? 1) + 1));
    const st = storageOf(s.libRef, taken);
    if (st !== s.libRef) keys.push(s.libRef, st);
    const recs: SchRawRecord[] = s.bags.map((b) => (b.int('RECORD', -1) === SR.PIN ? { kind: 1, data: encodeBinaryPin(b) } : { kind: 0, data: b.toBytes(), bag: b }));
    cfbPut(root, `${st}/Data`, joinSchRecords(recs));
    // Pin text the 8-bit record can't hold (Cyrillic names, µ in a description) in PinWideText, as the desktop software keeps it
    const wide = writePinWideText(s.bags.filter((b) => b.int('RECORD', -1) === SR.PIN));
    if (wide) cfbPut(root, `${st}/PinWideText`, wide);
  });
  cfbPut(root, 'FileHeader', joinSchRecords([{ kind: 0, data: head.toBytes(), bag: head }]));
  if (keys.length) {
    const sk = PropertyBag.from({ KEYCOUNT: keys.length / 2 });
    for (let i = 0; i < keys.length; i += 2) { sk.set(`LIBREF${i / 2}`, keys[i]!); sk.set(`SECTIONKEY${i / 2}`, keys[i + 1]!); }
    cfbPut(root, 'SectionKeys', joinSchRecords([{ kind: 0, data: sk.toBytes(), bag: sk }]));
  }
  cfbPut(root, 'Storage', binToBytes('\x15\0\0\0|HEADER=Icon storage\0'));
  return writeCfb(root);
}
