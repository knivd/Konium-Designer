/**
 * A schematic library open for editing. Each symbol is edited as a small schematic (its
 * "view"): HEADER, a SHEET made from the library's own sheet settings, the COMPONENT record,
 * then its children owned by index — the form the schematic editor already understands. Views
 * are made when a symbol is first shown and turned back into library records on save; symbols
 * never shown keep their original bytes.
 */
import { cfbFind, cfbPut, cloneCfb, writeCfb, type CfbFile } from '../formats/cfb/cfb';
import { joinSchRecords, type SchRawRecord } from '../formats/altium/framing';
import { PropertyBag } from '../formats/altium/props';
import { encodeBinaryPin, readSchLib, symbolRecordCount, writeSchLib, type LibSymbol } from '../formats/altium/schlib';
import { binToBytes } from '../formats/text';
import { Diagnostics } from './common';
import { SR, rederive, deriveSheet, setSchCoord, type SchDocument } from './sch';
import { uniqueId } from './schEdit';
import { SCH_UNIT } from '../core/units';

export interface SchLibDocument {
  kind: 'SchLib';
  name: string;
  /** The file as read (streams we don't model, such as Storage, are kept); null for a new library. */
  cfb: CfbFile | null;
  header: PropertyBag;
  symbols: LibSymbol[];
  /** Views of the symbols shown so far (the source of truth for them until saved). */
  views: Map<LibSymbol, SchDocument>;
  diags: Diagnostics;
}

const NESTS_UNDER: Record<number, number> = { [SR.IMPLEMENTATION]: SR.IMPLEMENTATION_LIST, [SR.MAP_DEFINER_LIST]: SR.IMPLEMENTATION, [SR.MAP_DEFINER]: SR.MAP_DEFINER_LIST, [SR.IMPL_PARAMS]: SR.IMPLEMENTATION };

export function openSchLib(bytes: Uint8Array, name: string): SchLibDocument {
  const lib = readSchLib(bytes, name);
  const diags = new Diagnostics();
  diags.info(`${lib.symbols.length} components`);
  return { kind: 'SchLib', name, cfb: lib.cfb ?? null, header: lib.header, symbols: lib.symbols, views: new Map(), diags };
}

export function newSchLib(name: string): SchLibDocument {
  const doc = openSchLib(writeSchLib([newSymbol('Component_1')]), name);
  doc.cfb = null;
  return doc;
}

/** A blank symbol, as Tools › New Component makes it: designator U?, one part, no graphics. */
export function newSymbol(libRef: string): LibSymbol {
  const comp = PropertyBag.from({ RECORD: SR.COMPONENT, LIBREFERENCE: libRef, PARTCOUNT: 2, DISPLAYMODECOUNT: 1, INDEXINSHEET: -1, OWNERPARTID: -1,
    CURRENTPARTID: 1, LIBRARYPATH: '*', SOURCELIBRARYNAME: '*', SHEETPARTFILENAME: '*', TARGETFILENAME: '*', UNIQUEID: uniqueId(), AREACOLOR: 11599871, COLOR: 128,
    PARTIDLOCKED: 'F', DESIGNITEMID: libRef, ALLPINCOUNT: 0 });
  const des = PropertyBag.from({ RECORD: SR.DESIGNATOR, INDEXINSHEET: -1, OWNERPARTID: -1, COLOR: 8388608, FONTID: 1, TEXT: 'U?', NAME: 'Designator', READONLYSTATE: 1, UNIQUEID: uniqueId() });
  setSchCoord(des, 'LOCATION.X', -5 * SCH_UNIT); setSchCoord(des, 'LOCATION.Y', 5 * SCH_UNIT);
  const com = PropertyBag.from({ RECORD: SR.PARAMETER, INDEXINSHEET: -1, OWNERPARTID: -1, COLOR: 8388608, FONTID: 1, ISHIDDEN: 'T', TEXT: '*', NAME: 'Comment', UNIQUEID: uniqueId() });
  setSchCoord(com, 'LOCATION.X', -5 * SCH_UNIT); setSchCoord(com, 'LOCATION.Y', -15 * SCH_UNIT);
  const list = PropertyBag.from({ RECORD: SR.IMPLEMENTATION_LIST });
  return { libRef, description: '', parts: 1, storage: '', bags: [comp, des, com, list] };
}

const textRec = (bag: PropertyBag): SchRawRecord => ({ kind: 0, data: bag.toBytes(), bag });

/** The symbol as a schematic: object 0 is the sheet, object 1 the component, children own to it. */
export function symbolView(lib: SchLibDocument, sym: LibSymbol): SchDocument {
  const header = PropertyBag.from({ HEADER: 'Protel for Windows - Schematic Capture Binary File Version 5.0', WEIGHT: sym.bags.length });
  const sheet = lib.header.clone();
  // One pass: a library of thousands of components has thousands of these keys
  sheet.replaceGroup((k) => /^(HEADER|WEIGHT|MINORVERSION|UNIQUEID|COMPCOUNT|LIBREF\d+|COMPDESCR\d+|PARTCOUNT\d+|ALIASLIST\d+)$/i.test(k), []);
  sheet.set('RECORD', String(SR.SHEET));
  const records: SchRawRecord[] = [textRec(header), textRec(sheet)];
  const last = new Map<number, number>();
  sym.bags.forEach((b, i) => {
    const bag = b.clone();
    if (i > 0) {
      // Library children own to the component by position; nested records name their parent's
      // position (or, where a writer left it out, follow the record they nest under)
      const rec = bag.int('RECORD', -1), parent = NESTS_UNDER[rec];
      const own = bag.has('OWNERINDEX') ? bag.int('OWNERINDEX') : parent !== undefined ? last.get(parent) ?? 0 : 0;
      bag.setRaw(bag.keys().find((k) => k.toUpperCase() === 'OWNERINDEX') ?? 'OWNERINDEX', String(own + 1));
      last.set(rec, i);
    }
    records.push(textRec(bag));
  });
  const doc: SchDocument = { kind: 'SchDoc', name: `${lib.name} › ${sym.libRef}`, cfb: null, asciiEol: null, records, objects: [], sheet: deriveSheet(undefined), diags: new Diagnostics() };
  rederive(doc);
  return doc;
}

/** A view back to library records: the component first, then children owned by position. */
export function viewBags(view: SchDocument): PropertyBag[] {
  const out: PropertyBag[] = [];
  const recs = view.records.slice(2);
  const comp = recs.findIndex((r) => r.bag?.int('RECORD', -1) === SR.COMPONENT);
  if (comp < 0) return [];
  const order = [comp, ...recs.map((_, i) => i).filter((i) => i !== comp)];
  const pos = new Map(order.map((i, p) => [i + 1, p]));       // view object index → library position
  for (const i of order) {
    const b = recs[i]!.bag?.clone();
    if (!b) continue;
    if (i !== comp) {
      const key = b.keys().find((k) => k.toUpperCase() === 'OWNERINDEX') ?? 'OWNERINDEX';
      const owner = b.has('OWNERINDEX') ? b.int('OWNERINDEX') : comp + 1;
      const p = pos.get(owner) ?? 0;
      // Direct children carry no index (as Altium writes them); nested records keep their parent's position
      const rec = b.int('RECORD', -1);
      if (p === 0 && NESTS_UNDER[rec] === undefined) b.delete(key); else b.setRaw(key, String(p));
    }
    out.push(b);
  }
  return out;
}

/** The library's symbols with their current content (views folded back in). */
export function currentSymbols(lib: SchLibDocument): LibSymbol[] {
  return lib.symbols.map((s) => {
    const v = lib.views.get(s);
    if (!v) return s;
    const bags = viewBags(v);
    const comp = bags[0]!;
    return { ...s, bags, libRef: comp.get('LIBREFERENCE') ?? s.libRef, description: comp.get('COMPONENTDESCRIPTION') ?? '', parts: Math.max(1, comp.int('PARTCOUNT', 2) - 1) };
  });
}

/**
 * Save: FileHeader lists the components (COMPCOUNT, LIBREFn, COMPDESCRn, PARTCOUNTn) with every
 * other header setting kept; each symbol's Data stream is rewritten only if it was shown (or
 * is new); storages of removed symbols go; SectionKeys maps long names to storages.
 */
export function writeSchLibDoc(lib: SchLibDocument): Uint8Array {
  const syms = currentSymbols(lib);
  if (!lib.cfb) return writeSchLib(syms);
  const root = cloneCfb(lib.cfb.root);
  const head = lib.header.clone();
  head.set('COMPCOUNT', String(syms.length));
  head.set('WEIGHT', String(syms.reduce((n, s) => n + symbolRecordCount(s), 1)));
  // The component list, in place and in the file's own key style (LibRef0 or LIBREF0)
  const mixed = head.keys().some((k) => /^LibRef\d+$/.test(k));
  const K = (k: string) => (mixed ? k : k.toUpperCase());
  const list: [string, string][] = [];
  syms.forEach((sy, i) => {
    list.push([K(`LibRef${i}`), sy.libRef]);
    if (sy.description) list.push([K(`CompDescr${i}`), sy.description]);
    const alias = lib.symbols[i]?.libRef === sy.libRef ? lib.symbols[i]!.aliases : undefined;
    if (alias) list.push([K(`AliasList${i}`), alias]);
    list.push([K(`PartCount${i}`), String(sy.parts + 1)]);
  });
  head.replaceGroup((k) => /^(LIBREF|COMPDESCR|PARTCOUNT|ALIASLIST)\d+$/i.test(k), list);
  // Storages: a symbol keeps its own unless it is new or renamed
  const storages = syms.map((s, i) => { const o = lib.symbols[i]!; return o.storage && o.libRef === s.libRef ? o.storage : ''; });
  const taken = new Set(storages.filter(Boolean).map((x) => x.toLowerCase()));
  syms.forEach((s, i) => { if (!storages[i]) { storages[i] = storageName(s.libRef, taken); taken.add(storages[i]!.toLowerCase()); } });
  const keys: [string, string][] = [];
  syms.forEach((s, i) => {
    const st = storages[i]!, o = lib.symbols[i]!;
    if (st !== s.libRef) keys.push([s.libRef, st]);
    if (lib.views.has(o) || st !== o.storage || !cfbFind(root, `${st}/Data`)) {
      const recs: SchRawRecord[] = s.bags.map((b) => (b.int('RECORD', -1) === SR.PIN ? { kind: 1, data: encodeBinaryPin(b) } : { kind: 0, data: b.toBytes(), bag: b }));
      const data = joinSchRecords(recs);
      const was = cfbFind(root, `${st}/Data`)?.data;
      cfbPut(root, `${st}/Data`, data);
      // Per-pin text settings follow pin order: once the pins change they no longer match
      if (!was || was.length !== data.length || was.some((v, k) => v !== data[k])) {
        const dir = cfbFind(root, st);
        if (dir) dir.children = dir.children.filter((c) => c.name !== 'PinTextData');
      }
    }
  });
  // Symbol storages no longer used (removed or renamed components) go
  root.children = root.children.filter((c) => c.kind !== 'storage' || taken.has(c.name.toLowerCase()) || !c.children.some((x) => x.name === 'Data'));
  cfbPut(root, 'FileHeader', joinSchRecords([textRec(head)]));
  root.children = root.children.filter((c) => c.name !== 'SectionKeys');
  if (keys.length) {
    const sk = PropertyBag.from({ KEYCOUNT: keys.length });
    keys.forEach(([ref, st], i) => { sk.set(`LIBREF${i}`, ref); sk.set(`SECTIONKEY${i}`, st); });
    cfbPut(root, 'SectionKeys', joinSchRecords([textRec(sk)]));
  }
  if (!cfbFind(root, 'Storage')) cfbPut(root, 'Storage', binToBytes('\x15\0\0\0|HEADER=Icon storage\0'));
  return writeCfb({ ...lib.cfb, root });
}

function storageName(libRef: string, taken: Set<string>): string {
  const base = libRef.replace(/[/\\:*?"<>|!]/g, '_').slice(0, 31) || 'Component';
  let s = base;
  for (let i = 1; taken.has(s.toLowerCase()); i++) s = `${base.slice(0, 27)}_${i}`;
  return s;
}
