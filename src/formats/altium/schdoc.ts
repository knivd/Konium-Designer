import { cfbPut, cloneCfb, cfbStream, isCfb, newEntry, readCfb, writeCfb } from '../cfb/cfb';
import { joinSchRecords, splitSchRecords, type SchRawRecord } from './framing';
import { PropertyBag } from './props';
import { decodeBinaryPin } from './schlib';
import { binToBytes, bytesToBin, codePageOfStreams, currentCodePage, withCodePage } from '../text';
import { inflateRawSync } from '../inflate';
import { Diagnostics } from '../../model/common';
import { ADDITIONAL_RECORDS, HR, SR, SR_NAME, rederive, deriveSheet, type SchDocument } from '../../model/sch';

const BIN_HEADER = 'Protel for Windows - Schematic Capture Binary File Version 5.0';

export function readSchDoc(bytes: Uint8Array, name: string): SchDocument {
  // Text without a %UTF8% twin is in the code page of the author's Windows: told from the records (or as chosen)
  const cfb0 = isCfb(bytes) ? readCfb(bytes) : null;
  const cp = codePageOfStreams(...(cfb0 ? [cfbStream(cfb0.root, 'FileHeader'), cfbStream(cfb0.root, 'Additional')] : [bytes]));
  return withCodePage(cp, () => readSchDocIn(bytes, name, cfb0));
}
function readSchDocIn(bytes: Uint8Array, name: string, cfb0: ReturnType<typeof readCfb> | null): SchDocument {
  const diags = new Diagnostics();
  let records: SchRawRecord[];
  let cfb = null;
  let asciiEol: string | null = null;

  if (cfb0) {
    cfb = cfb0;
    const fh = cfbStream(cfb.root, 'FileHeader');
    if (!fh) throw new Error('SchDoc has no FileHeader stream');
    records = splitSchRecords(fh);
  } else {
    // ASCII variant: one "|KEY=VALUE…" record per line
    const text = bytesToBin(bytes);
    if (!text.startsWith('|HEADER=')) throw new Error('not a schematic document Konium Designer can read (binary or ASCII)');
    asciiEol = text.includes('\r\n') ? '\r\n' : '\n';
    records = text.split(asciiEol).filter((l) => l.length > 0)
      .map((l) => { const data = binToBytes(l); return { kind: 0, data, bag: PropertyBag.parse(data) }; });
    diags.info('ASCII schematic format');
  }

  const header = records[0]?.bag?.get('HEADER');
  if (!header) diags.warn('first record is not a HEADER');
  else if (!/Schematic|Harness/.test(header)) diags.warn(`unexpected header: ${header}`);

  const doc: SchDocument = { kind: 'SchDoc', name, cfb, asciiEol, records, objects: [], sheet: deriveSheet(undefined), diags };
  // Harnesses live in the Additional stream: its records join the list after FileHeader's
  const add = cfb ? cfbStream(cfb.root, 'Additional') : null;
  if (add && add.length > 4) {
    try {
      const extra = splitSchRecords(add);
      const head = extra.shift();
      if (head?.bag) {
        const base = records.length - 1;
        doc.additionalHead = head.bag;
        doc.additionalOwners = additionalOwnerMode(extra, base);
        for (const r of extra) {
          r.additional = true;
          // Local owner indices become indices into the whole list while the document is open
          if (doc.additionalOwners === 'local' && r.bag?.has('OWNERINDEX')) r.bag.setRaw('OWNERINDEX', String(r.bag.int('OWNERINDEX') + base));
          records.push(r);
        }
        if (extra.length) diags.info(`${extra.length} harness records (Additional)`);
      }
    } catch { diags.warn('Additional stream unreadable; kept as is'); }
  }
  if (currentCodePage() !== 1252) diags.info(`text in Windows code page ${currentCodePage()}`);
  rederive(doc);

  // Inventory: which record types we model, which we only preserve
  const counts = new Map<number, number>();
  let binary = 0;
  for (const r of records.slice(1)) {
    if (!r.bag) { binary++; continue; }
    const t = r.bag.int('RECORD', -1);
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const unmodelled = doc.objects.filter((o) => o.kind === 'meta').map((o) => o.record);
  const unknown = [...new Set(unmodelled)].filter((t) => ![SR.SHEET, SR.HEADER, SR.IMPLEMENTATION_LIST, SR.IMPLEMENTATION,
    SR.MAP_DEFINER_LIST, SR.MAP_DEFINER, SR.IMPL_PARAMS, SR.TEMPLATE, SR.PARAMETER_SET, SR.HYPERLINK, ...HARNESS_TIES].includes(t as never));
  diags.info(`${records.length - 1} records, ${counts.size} types${binary ? `, ${binary} binary` : ''}`);
  for (const t of unknown) diags.warn(`record ${t} (${SR_NAME[t] ?? 'unknown'}) ×${counts.get(t)} preserved but not drawn`);
  return doc;
}

/** A harness layout's ties to its wiring diagram (wires, splices, cables … and logical signal links): kept, not drawn. */
const HARNESS_TIES = [HR.SIGNAL_LINK, HR.LAYOUT_WIRE, HR.LAYOUT_SPLICE, HR.LAYOUT_NO_CONNECT, HR.LAYOUT_SHIELD, HR.LAYOUT_TWIST, HR.LAYOUT_CABLE];

/** A file embedded in the document (Storage stream): images placed with Embed Image on. Data is zlib-compressed. */
export interface StoredFile { name: string; data: Uint8Array }

/**
 * The Storage stream: a "|HEADER=Icon storage|WEIGHT=n" record, then n entries of 5 bytes,
 * a length-prefixed file name, a 32-bit size and the zlib data. ASCII documents carry the same
 * as records with NAME, DATA_LEN and DATA (hex).
 */
export function schStorage(doc: SchDocument): StoredFile[] {
  const out: StoredFile[] = [];
  if (doc.cfb) {
    const st = cfbStream(doc.cfb.root, 'Storage');
    if (!st || st.length < 4) return out;
    const dv = new DataView(st.buffer, st.byteOffset, st.byteLength);
    const len = dv.getUint32(0, true) & 0xffffff;
    const head = PropertyBag.parse(st.subarray(4, 4 + len));
    const weight = head.int('WEIGHT');
    let at = 4 + len;
    for (let i = 0; i < weight && at + 6 <= st.length; i++) {
      at += 5;
      const n = st[at]!;
      const name = bytesToBin(st.subarray(at + 1, at + 1 + n));
      at += 1 + n;
      if (at + 4 > st.length) break;
      const size = dv.getUint32(at, true);
      at += 4;
      if (at + size > st.length) break;
      out.push({ name, data: st.subarray(at, at + size) });
      at += size;
    }
    return out;
  }
  for (const r of doc.records) {
    const b = r.bag;
    if (!b?.has('DATA_LEN') || !b.has('DATA')) continue;
    const hex = b.get('DATA') ?? '';
    const data = new Uint8Array(hex.length >> 1);
    for (let i = 0; i < data.length; i++) data[i] = parseInt(hex.substr(i * 2, 2), 16);
    out.push({ name: b.get('NAME') ?? '', data });
  }
  return out;
}

/** The stored file an image record names (exact, else by the end of the path, ignoring case). */
export function storedFile(files: readonly StoredFile[], fileName: string): StoredFile | undefined {
  // A "|" in a record's value is written "¦" (a harness connector's view is named by its settings, "ViewSide=…|Zoom=…")
  const want = fileName.toLowerCase().replace(/¦/g, '|');
  return files.find((f) => f.name.toLowerCase() === want)
    ?? files.find((f) => f.name.toLowerCase().endsWith(want) || want.endsWith(f.name.toLowerCase()))
    ?? files.find((f) => f.name.split(/[\\/]/).pop()!.toLowerCase() === want.split(/[\\/]/).pop());
}

/**
 * Does the Additional stream number owners on from FileHeader's objects ('continued', as
 * KiCad's importer reads it) or within itself ('local')? Whichever makes children land on a
 * harness connector [est: continued for new files].
 */
function additionalOwnerMode(extra: SchRawRecord[], base: number): 'continued' | 'local' {
  let cont = 0, local = 0;
  extra.forEach((r) => {
    if (!r.bag?.has('OWNERINDEX')) return;
    const o = r.bag.int('OWNERINDEX');
    const at = (i: number) => extra[i]?.bag?.int('RECORD', -1) === SR.HARNESS_CONNECTOR;
    if (at(o - base)) cont++;
    if (at(o)) local++;
  });
  return local > cont ? 'local' : 'continued';
}

/**
 * The records as the file stores them: FileHeader's (in order), then the Additional stream's,
 * owner indices renumbered for where each record lands. An unchanged document maps onto itself.
 */
export function splitForWrite(doc: SchDocument): { main: SchRawRecord[]; extra: SchRawRecord[] } {
  const recs = doc.records;
  const isExtra = (r: SchRawRecord) => !!r.additional || (doc.asciiEol === null && !!r.bag && ADDITIONAL_RECORDS.has(r.bag.int('RECORD', -1)) && r.additional !== false);
  const mainIdx: number[] = [], extraIdx: number[] = [];
  for (let i = 1; i < recs.length; i++) (isExtra(recs[i]!) ? extraIdx : mainIdx).push(i - 1);
  const local = doc.additionalOwners === 'local';
  const map = new Map<number, number>();
  mainIdx.forEach((o, k) => map.set(o, k));
  extraIdx.forEach((o, k) => map.set(o, local ? k : mainIdx.length + k));
  const out = (o: number): SchRawRecord => {
    const r = recs[o + 1]!;
    if (!r.bag?.has('OWNERINDEX')) return r;
    const was = r.bag.int('OWNERINDEX');
    const now = map.get(was);
    if (now === undefined || now === was) return r;
    const bag = r.bag.clone();
    bag.setRaw('OWNERINDEX', String(now));
    return { ...r, bag };
  };
  return { main: [recs[0]!, ...mainIdx.map(out)], extra: extraIdx.map(out) };
}

export function writeSchDoc(doc: SchDocument): Uint8Array {
  if (doc.asciiEol !== null) {
    const lines = doc.records.map((r) => bytesToBin(r.bag ? r.bag.toBytes() : r.data));
    return binToBytes(lines.join(doc.asciiEol) + doc.asciiEol);
  }
  const root = doc.cfb ? cloneCfb(doc.cfb.root) : newEntry('Root Entry', 'root');
  const { main, extra } = splitForWrite(doc);
  cfbPut(root, 'FileHeader', joinSchRecords(main));
  if (extra.length || doc.additionalHead) {
    const head = doc.additionalHead ?? PropertyBag.from({ HEADER: BIN_HEADER, WEIGHT: 0 });
    // WEIGHT counts the records (a header written without one keeps it that way while empty)
    const want = String(extra.length);
    const h = head.has('WEIGHT') || extra.length ? (head.get('WEIGHT') === want ? head : (() => { const c = head.clone(); c.setRaw('WEIGHT', want); return c; })()) : head;
    const bytes = joinSchRecords([{ kind: 0, data: h.toBytes(), bag: h }, ...extra]);
    // Unchanged: the stream stays as read
    const old = doc.cfb ? cfbStream(doc.cfb.root, 'Additional') : null;
    if (!old || old.length !== bytes.length || old.some((v, i) => v !== bytes[i])) cfbPut(root, 'Additional', bytes);
  }
  return writeCfb(root);
}

/**
 * A schematic as AD's ASCII schematic file (File › Save As › Advanced Schematic ascii): its
 * records one a line, the Additional stream's after FileHeader's (owners numbered on from them),
 * CR LF between them. Embedded images aren't carried (their records keep the file name).
 */
export function writeSchAscii(doc: SchDocument): { bytes: Uint8Array; warnings: string[] } {
  const warnings: string[] = [];
  if (doc.asciiEol !== null) return { bytes: writeSchDoc(doc), warnings };
  const { main, extra } = splitForWrite({ ...doc, additionalOwners: 'continued' });
  const lines: string[] = [];
  [...main, ...extra].forEach((r, i) => {
    let bag = r.bag ?? (r.kind === 1 ? decodeBinaryPin(r.data) : PropertyBag.parse(r.data));
    if (!bag) return;
    if (i === 0) { bag = bag.clone(); bag.set('HEADER', 'Protel for Windows - Schematic Capture Ascii File Version 5.0'); bag.set('WEIGHT', String(main.length - 1 + extra.length)); }
    lines.push(bytesToBin(bag.toBytes()).replace(/\0+$/, ''));
  });
  if (doc.cfb && schStorage(doc).length) warnings.push(`${doc.name}: embedded images aren't carried in an ASCII schematic (they keep their file names)`);
  return { bytes: binToBytes(lines.join('\r\n') + '\r\n'), warnings };
}

/** The document parameters a blank AD17 sheet starts with (hidden, value "*", read-only name), in its order. */
export const NEW_SHEET_PARAMETERS = ['CurrentTime', 'CurrentDate', 'Time', 'Date', 'DocumentFullPathAndName', 'DocumentName', 'ModifiedDate', 'ApprovedBy',
  'CheckedBy', 'Author', 'CompanyName', 'DrawnBy', 'Engineer', 'Organization', 'Address1', 'Address2', 'Address3', 'Address4', 'Title', 'DocumentNumber',
  'Revision', 'SheetNumber', 'SheetTotal', 'Rule', 'ImagePath', 'ProjectName', 'Application_BuildNumber'];

const newId = () => Array.from({ length: 8 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

/**
 * A blank sheet as AD17's File › New › Schematic writes it: the SHEET record (A4 unless
 * `style` says otherwise, Dxp units unless `unit` does) and the 27 document parameters.
 */
export function newSchDoc(name: string, style = 0, unit = 4): SchDocument {
  const header = PropertyBag.from({ HEADER: BIN_HEADER, WEIGHT: 1 + NEW_SHEET_PARAMETERS.length, MINORVERSION: 2, UNIQUEID: newId() });
  const sheet = PropertyBag.from({
    RECORD: SR.SHEET, FONTIDCOUNT: 1, SIZE1: 10, FONTNAME1: 'Times New Roman', USEMBCS: true, ISBOC: true,
    HOTSPOTGRIDON: true, HOTSPOTGRIDSIZE: 4, ...(style ? { SHEETSTYLE: style } : {}), SYSTEMFONT: 1, BORDERON: true, TITLEBLOCKON: true, SHEETNUMBERSPACESIZE: 4,
    AREACOLOR: 16317695, SNAPGRIDON: true, SNAPGRIDSIZE: 10, VISIBLEGRIDON: true, VISIBLEGRIDSIZE: 10,
    CUSTOMX: 1500, CUSTOMY: 950, CUSTOMXZONES: 6, CUSTOMYZONES: 4, CUSTOMMARGINWIDTH: 20, DISPLAY_UNIT: unit,
  });
  const params = NEW_SHEET_PARAMETERS.map((n, i) => PropertyBag.from({ RECORD: SR.PARAMETER, ...(i ? { INDEXINSHEET: i } : {}), OWNERPARTID: -1, COLOR: 8388608, FONTID: 1,
    ISHIDDEN: true, TEXT: '*', NAME: n, READONLYSTATE: 1, UNIQUEID: newId() }));
  const records: SchRawRecord[] = [header, sheet, ...params].map((bag) => ({ kind: 0, data: bag.toBytes(), bag }));
  const doc: SchDocument = { kind: 'SchDoc', name, cfb: null, asciiEol: null, records, objects: [], sheet: deriveSheet(undefined), diags: new Diagnostics() };
  rederive(doc);
  return doc;
}

/** zlib (RFC 1950) in stored blocks: written at once with no compressor (a picture is compressed already). */
export function zlibStored(b: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(b.length / 65535));
  const out = new Uint8Array(2 + blocks * 5 + b.length + 4);
  out[0] = 0x78; out[1] = 0x01;
  let o = 2;
  for (let i = 0; i < blocks; i++) {
    const part = b.subarray(i * 65535, Math.min(b.length, (i + 1) * 65535));
    out[o++] = i === blocks - 1 ? 1 : 0;
    out[o++] = part.length & 255; out[o++] = part.length >> 8; out[o++] = ~part.length & 255; out[o++] = (~part.length >> 8) & 255;
    out.set(part, o); o += part.length;
  }
  let a = 1, c = 0;
  for (let i = 0; i < b.length; i++) { a = (a + b[i]!) % 65521; c = (c + a) % 65521; }
  const adler = ((c << 16) | a) >>> 0;
  out[o++] = adler >>> 24; out[o++] = (adler >>> 16) & 255; out[o++] = (adler >>> 8) & 255; out[o++] = adler & 255;
  return out;
}
/** A stored file's bytes, unpacked at once (its zlib header taken off). */
export function storedBytes(f: StoredFile): Uint8Array {
  return inflateRawSync(f.data.subarray(2));
}
/**
 * The Storage stream holding these files, as the suite writes it: the "|HEADER=Icon storage|WEIGHT=n"
 * record, then per file a u32 length (with 0x01 in its top byte), 0xD0, its name (a length byte and
 * the name), a u32 size and its zlib data [checked against the suite's files].
 */
export function storageStream(files: { name: string; bytes: Uint8Array }[]): Uint8Array {
  // (none: the header alone, as a new document has it)
  const head = binToBytes(files.length ? `|HEADER=Icon storage|WEIGHT=${files.length}\0` : '|HEADER=Icon storage\0');
  const parts: Uint8Array[] = [];
  const u32 = (v: number) => new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
  parts.push(u32(head.length), head);
  for (const f of files) {
    const name = binToBytes(f.name.slice(0, 255)), data = zlibStored(f.bytes);
    parts.push(u32((1 + 1 + name.length + 4 + data.length) | 0x01000000), new Uint8Array([0xd0, name.length]), name, u32(data.length), data);
  }
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
