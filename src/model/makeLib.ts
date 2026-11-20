/**
 * Design › Make Schematic Library: one library symbol per library reference placed in the
 * project, taken from its first placed part — every part and display mode, as a placed part
 * carries them — turned back upright and unmirrored about its origin, the designator back to
 * its prefix and '?', the sheet-only keys dropped.
 */
import { PropertyBag } from '../formats/altium/props';
import type { SchRawRecord } from '../formats/altium/framing';
import { Diagnostics } from './common';
import { SR, deriveSheet, rederive, type SchDocument } from './sch';
import type { SheetInput } from './compile';
import { viewBags } from './schLib';
import { identity, transformBag } from './schTransform';

const SHEET_ONLY = ['INDEXINSHEET', 'SHEETPARTFILENAME', 'TARGETFILENAME', 'ORIENTATION', 'ISMIRRORED', 'LOCATION.X', 'LOCATION.Y', 'LOCATION.X_FRAC', 'LOCATION.Y_FRAC',
  'PARTIDLOCKED', 'DESIGNATORLOCKED', 'PINSMOVEABLE', 'NOTUSEDBTABLENAME', 'DATABASETABLENAME', 'DESIGNITEMID_NOTUSED'];

export interface MadeSymbol { libRef: string; description: string; parts: number; bags: PropertyBag[] }

export function symbolsFromSheets(sheets: SheetInput[]): MadeSymbol[] {
  const out: MadeSymbol[] = [];
  const seen = new Set<string>();
  for (const { doc } of sheets) {
    for (const o of doc.objects) {
      if (o.kind !== 'component' || !o.libRef || seen.has(o.libRef.toUpperCase())) continue;
      seen.add(o.libRef.toUpperCase());
      out.push(symbolOf(doc, o.index));
    }
  }
  return out;
}

/** A placed part as its library symbol (every part and display mode it carries, upright about its origin). */
export function symbolOf(doc: SchDocument, ci: number): MadeSymbol {
  const comp = doc.objects[ci] as SchDocument['objects'][number] & { kind: 'component' };
  // The part and everything under it, in record order
  const mine = new Set([ci]);
  for (const o of doc.objects) if (o.owner >= 0 && mine.has(o.owner)) mine.add(o.index);
  const kids = doc.objects.filter((o) => o.index !== ci && mine.has(o.index));
  // Undo the part's placement: turn back, unmirror, to the origin
  const turn = identity(comp.at);
  turn.quarter = (4 - (comp.orient & 3)) % 4;
  const flat = identity(comp.at);
  flat.mirrorX = comp.mirrored;
  flat.d = { x: -comp.at.x, y: -comp.at.y };
  const place = (b: PropertyBag) => transformBag(transformBag(b, turn), flat);

  const cb = doc.records[ci + 1]!.bag!.clone();
  for (const k of SHEET_ONLY) cb.delete(k);
  cb.set('CURRENTPARTID', '1');
  const header = PropertyBag.from({ HEADER: 'Protel for Windows - Schematic Capture Binary File Version 5.0', WEIGHT: kids.length + 1 });
  const sheet = PropertyBag.from({ RECORD: SR.SHEET });
  const pos = new Map<number, number>([[ci, 1]]);
  kids.forEach((o, i) => pos.set(o.index, i + 2));
  const recs: SchRawRecord[] = [header, sheet, cb].map((bag) => ({ kind: 0, data: bag.toBytes(), bag }));
  for (const o of kids) {
    const b = place(doc.records[o.index + 1]!.bag!);
    b.set('OWNERINDEX', String(pos.get(o.owner) ?? 1));
    if (o.record === SR.DESIGNATOR) b.set('TEXT', `${(b.get('TEXT') ?? 'U').replace(/\d+[A-Z]*$/i, '').replace(/\?$/, '') || 'U'}?`);
    b.delete('INDEXINSHEET');
    recs.push({ kind: 0, data: b.toBytes(), bag: b });
  }
  const view: SchDocument = { kind: 'SchDoc', name: comp.libRef, cfb: null, asciiEol: null, records: recs, objects: [], sheet: deriveSheet(undefined), diags: new Diagnostics() };
  rederive(view);
  const bags = viewBags(view);
  return { libRef: comp.libRef, description: cb.get('COMPONENTDESCRIPTION') ?? '', parts: Math.max(1, comp.partCount - 1), bags };
}

/**
 * Design › Create Component From Sheet: a symbol whose pins are the sheet's ports — inputs (and
 * unspecified, bidirectional) down the left, outputs down the right, 100 mil apart — on a body
 * wide enough for the names; named after the sheet.
 */
export function symbolFromPorts(sheetName: string, ports: { name: string; io: number }[]): MadeSymbol {
  const libRef = sheetName.replace(/\.schdoc$/i, '');
  const left = ports.filter((p) => p.io !== 1), right = ports.filter((p) => p.io === 1);
  const rows = Math.max(1, left.length, right.length);
  const longest = Math.max(3, ...ports.map((p) => p.name.length));
  const w = Math.max(60, Math.ceil((longest * 2 * 7 + 40) / 10) * 10);
  const h = (rows + 1) * 10;
  const comp = PropertyBag.from({ RECORD: SR.COMPONENT, LIBREFERENCE: libRef, PARTCOUNT: 2, DISPLAYMODECOUNT: 1, OWNERPARTID: -1, CURRENTPARTID: 1, AREACOLOR: 11599871, COLOR: 128,
    DESIGNITEMID: libRef, COMPONENTDESCRIPTION: `From ${sheetName}` });
  const des = PropertyBag.from({ RECORD: SR.DESIGNATOR, OWNERPARTID: -1, COLOR: 8388608, FONTID: 1, TEXT: 'U?', NAME: 'Designator', READONLYSTATE: 1, 'LOCATION.Y': h + 2 });
  const body = PropertyBag.from({ RECORD: SR.RECTANGLE, OWNERPARTID: 1, LINEWIDTH: 1, COLOR: 128, AREACOLOR: 11599871, ISSOLID: true, 'LOCATION.X': 0, 'LOCATION.Y': 0, 'CORNER.X': w, 'CORNER.Y': h });
  const el = (io: number) => (io === 2 ? 0 : io === 1 ? 2 : io === 3 ? 1 : 4);
  const pins: PropertyBag[] = [];
  let n = 1;
  left.forEach((p, i) => pins.push(PropertyBag.from({ RECORD: SR.PIN, OWNERPARTID: 1, PINCONGLOMERATE: 2 | 0x18, PINLENGTH: 20, ELECTRICAL: el(p.io), NAME: p.name, DESIGNATOR: String(n++),
    'LOCATION.X': 0, 'LOCATION.Y': h - (i + 1) * 10, COLOR: 0 })));
  right.forEach((p, i) => pins.push(PropertyBag.from({ RECORD: SR.PIN, OWNERPARTID: 1, PINCONGLOMERATE: 0 | 0x18, PINLENGTH: 20, ELECTRICAL: el(p.io), NAME: p.name, DESIGNATOR: String(n++),
    'LOCATION.X': w, 'LOCATION.Y': h - (i + 1) * 10, COLOR: 0 })));
  return { libRef, description: `From ${sheetName}`, parts: 1, bags: [comp, des, body, ...pins, PropertyBag.from({ RECORD: SR.IMPLEMENTATION_LIST })] };
}
