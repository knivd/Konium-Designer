/**
 * PCB footprint libraries (.PcbLib).
 *
 * Layout (as KiCad's importer reads it): a CFB with `FileHeader`, `Library/Data` (a property
 * record, then u32 footprint count and one [u32 len][pascal name] subrecord per footprint), and
 * one storage per footprint, named after it (≤ 31 characters) holding:
 *   Parameters  — u32 length + |PATTERN=…|HEIGHT=…|DESCRIPTION=…|
 *   Data        — [u32 len][pascal name] subrecord, then primitive records of mixed types in
 *                 the PcbDoc binary format (tag + subrecords), coordinates relative to the
 *                 footprint origin
 *   WideStrings — Unicode text table, as WideStrings6 in a PcbDoc
 * Footprints are matched by the PATTERN in Parameters, so long-name section keys don't matter.
 *
 * Cross-checked with KiCad's importer (docs/FORMATS.md says what each part's reading rests on).
 */
import { cfbPut, cfbStream, newEntry, readCfb, writeCfb, type CfbEntry, type CfbFile } from '../cfb/cfb';
import { BinReader, BinWriter } from '../bin';
import { PCB_TAG, countHeader, joinBinaryRecords, splitBinaryRecords, type PcbRawRecord } from './framing';
import { PropertyBag } from './props';
import { newLibraryRecord } from './board6';
import { ARC, FILL, PAD, REGION, TEXT, TRACK, VIA, get, put } from './pcbLayouts';
import { decodePrim, parseWideStrings } from './pcbdoc';
import { linkPadShapes } from '../../model/padShapes';
import { transformRecord } from './pcbTransform';
import { ansiToStr, binToBytes, bytesToBin, codePageOfStreams, currentCodePage, toCp1252Lossy, withCodePage } from '../text';
import { parseLength, UNITS_PER_MIL } from '../../core/units';
import { Diagnostics } from '../../model/common';
import type { PcbPrim } from '../../model/pcb';
import type { BBox, Vec2 } from '../../core/geom';

export interface Footprint {
  name: string;
  storage: string;
  description: string;
  height: string;
  records: PcbRawRecord[];
  prims: PcbPrim[];
  /** Its Parameters as read (PATTERN, HEIGHT, DESCRIPTION, and what an import kept there: KICADSRC …). */
  params?: PropertyBag;
}

export interface PcbLibrary { kind: 'PcbLib'; name: string; cfb: CfbFile; footprints: Footprint[]; diags: Diagnostics }

function pascalAt(b: Uint8Array): string {
  if (!b.length) return '';
  return ansiToStr(bytesToBin(b.subarray(1, 1 + Math.min(b[0]!, b.length - 1))), currentCodePage());
}

/** The names in Library/Data, in library order (empty if it can't be read). */
function libraryOrder(root: CfbEntry): string[] {
  const data = cfbStream(root, 'Library/Data');
  if (!data) return [];
  try {
    const r = new BinReader(data);
    const n = r.u32() & 0x00ffffff;
    r.bytes(n); // library properties
    const count = r.u32();
    const out: string[] = [];
    for (let i = 0; i < count && r.remaining >= 4; i++) { const len = r.u32(); out.push(pascalAt(r.bytes(len))); }
    return out;
  } catch { return []; }
}

export function readPcbLib(bytes: Uint8Array, name: string): PcbLibrary {
  const cfb = readCfb(bytes);
  // Text without a %UTF8% twin is in the code page of the author's Windows (told from the footprints' parameters)
  const params = cfb.root.children.filter((st) => st.kind === 'storage').map((st) => cfbStream(st, 'Parameters'));
  return withCodePage(codePageOfStreams(cfbStream(cfb.root, 'Library/Data'), ...params), () => readPcbLibIn(cfb, name));
}
function readPcbLibIn(cfb: ReturnType<typeof readCfb>, name: string): PcbLibrary {
  const diags = new Diagnostics();
  const footprints: Footprint[] = [];
  for (const st of cfb.root.children) {
    if (st.kind !== 'storage' || /^(Library|FileVersionInfo|Models|ComponentParamsTOC|SectionKeys|ModelsNoEmbed|Textures|PadViaLibrary|LayerKindMapping|FileHeader)$/i.test(st.name)) continue;
    const params = cfbStream(st, 'Parameters');
    const data = cfbStream(st, 'Data');
    if (!data) continue;
    let bag = new PropertyBag();
    if (params && params.length >= 4) {
      const n = new DataView(params.buffer, params.byteOffset).getUint32(0, true) & 0x00ffffff;
      bag = PropertyBag.parse(params.subarray(4, 4 + n));
    }
    try {
      const r = new BinReader(data);
      const nameLen = r.u32();
      const inData = pascalAt(r.bytes(nameLen));
      footprints.push(lazyFootprint(bag.get('PATTERN') || inData || st.name, st, bag, data.subarray(r.pos), diags));
    } catch (e) {
      diags.warn(`${st.name}: ${(e as Error).message} — footprint skipped`);
    }
  }
  // Library/Data's order (a map: libraries of thousands of footprints sort at once)
  const order = new Map<string, number>();
  libraryOrder(cfb.root).forEach((n, i) => { const k = n.toLowerCase(); if (!order.has(k)) order.set(k, i); });
  if (order.size) footprints.sort((a, b) => (order.get(a.name.toLowerCase()) ?? 1e9) - (order.get(b.name.toLowerCase()) ?? 1e9));
  diags.info(`${footprints.length} footprint${footprints.length === 1 ? '' : 's'}`);
  return { kind: 'PcbLib', name, cfb, footprints, diags };
}

/**
 * A footprint as read: name, description and height now; its records are split and its
 * primitives decoded the first time they're used (a library of thousands opens at once).
 * A footprint whose records can't be read comes back empty, with a warning.
 */
function lazyFootprint(name: string, st: CfbEntry, bag: PropertyBag, body: Uint8Array, diags: Diagnostics): Footprint {
  let records: PcbRawRecord[] | null = null, prims: PcbPrim[] | null = null;
  const recs = () => {
    if (!records) {
      try { records = splitBinaryRecords(body); } catch (e) { records = []; diags.warn(`${st.name}: ${(e as Error).message} — footprint read as empty`); }
    }
    return records;
  };
  const fp = { name, storage: st.name, description: bag.get('DESCRIPTION') ?? '', height: bag.get('HEIGHT') ?? '' } as Footprint;
  Object.defineProperty(fp, 'params', { enumerable: false, configurable: true, value: bag });
  Object.defineProperty(fp, 'records', { enumerable: true, configurable: true, get: recs, set: (v: PcbRawRecord[]) => { records = v; prims = null; } });
  Object.defineProperty(fp, 'prims', {
    enumerable: true, configurable: true,
    get: () => {
      if (!prims) {
        const wide = parseWideStrings(cfbStream(st, 'WideStrings'));
        prims = recs().map((rec, i) => decodePrim(storageFor(rec.tag), rec, i, wide)).filter((p): p is PcbPrim => !!p);
        linkPadShapes(prims);
      }
      return prims;
    },
    set: (v: PcbPrim[]) => { prims = v; },
  });
  return fp;
}

/** The PcbDoc storage each primitive type lives in. */
export function storageFor(tag: number): string {
  switch (tag) {
    case PCB_TAG.ARC: return 'Arcs6';
    case PCB_TAG.PAD: return 'Pads6';
    case PCB_TAG.VIA: return 'Vias6';
    case PCB_TAG.TRACK: return 'Tracks6';
    case PCB_TAG.TEXT: return 'Texts6';
    case PCB_TAG.FILL: return 'Fills6';
    case PCB_TAG.REGION: return 'Regions6';
    case PCB_TAG.MODEL: return 'ComponentBodies6';
    default: return `Tag${tag}`;
  }
}

/* ─── Placing a footprint ────────────────────────────────────────────────────────────── */

const add = (b: Uint8Array, fl: Parameters<typeof get>[1], d: number) => { const v = get(b, fl); if (v !== undefined) put(b, fl, v + d); };

/** Region vertices are f64 pairs after the property block; holes follow as count + pairs. */
function translateRegion(s: Uint8Array, dx: number, dy: number): void {
  const dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
  let o = REGION.propsAt;
  const propLen = dv.getUint32(o, true) & 0x00ffffff;
  o += 4 + propLen;
  const shift = (count: number) => {
    for (let i = 0; i < count && o + 16 <= s.length; i++, o += 16) {
      dv.setFloat64(o, dv.getFloat64(o, true) + dx, true);
      dv.setFloat64(o + 8, dv.getFloat64(o + 8, true) + dy, true);
    }
  };
  const count = dv.getUint32(o, true); o += 4;
  shift(count);
  const holes = get(s, REGION.holeCount) ?? 0;
  for (let h = 0; h < holes && o + 4 <= s.length; h++) { const m = dv.getUint32(o, true); o += 4; shift(m); }
}

/**
 * A copy of a footprint record moved by (dx, dy) and owned by `component` (pads also take
 * `net`, others No Net). Unknown bytes are kept as the library wrote them.
 */
export function placeRecord(rec: PcbRawRecord, dx: number, dy: number, component: number, net = 0xffff): PcbRawRecord {
  const subs = rec.subs.map((x) => x.slice());
  const s = subs[0]!;
  switch (rec.tag) {
    case PCB_TAG.TRACK: add(s, TRACK.x1, dx); add(s, TRACK.y1, dy); add(s, TRACK.x2, dx); add(s, TRACK.y2, dy); put(s, TRACK.component, component); put(s, TRACK.net, 0xffff); break;
    case PCB_TAG.ARC: add(s, ARC.cx, dx); add(s, ARC.cy, dy); put(s, ARC.component, component); put(s, ARC.net, 0xffff); break;
    case PCB_TAG.VIA: add(s, VIA.x, dx); add(s, VIA.y, dy); put(s, VIA.component, component); put(s, VIA.net, net); break;
    case PCB_TAG.FILL: add(s, FILL.x1, dx); add(s, FILL.y1, dy); add(s, FILL.x2, dx); add(s, FILL.y2, dy); put(s, FILL.component, component); put(s, FILL.net, 0xffff); break;
    // The library's WideStrings6 index means nothing on the board: the 8-bit words make a new entry
    case PCB_TAG.TEXT: add(s, TEXT.x, dx); add(s, TEXT.y, dy); put(s, TEXT.component, component); if (s.length >= TEXT.wideIndex.off + 4) put(s, TEXT.wideIndex, 0xffffffff); break;
    case PCB_TAG.REGION: translateRegion(s, dx, dy); put(s, REGION.component, component); put(s, REGION.net, 0xffff); break;
    case PCB_TAG.PAD: { const p = subs[4]!; add(p, PAD.x, dx); add(p, PAD.y, dy); put(p, PAD.component, component); put(p, PAD.net, net); break; }
    // A 3D body: its outline and its 2D placement (MODEL.2D.X / Y) both move
    case PCB_TAG.MODEL: {
      const moved = dx || dy ? transformRecord({ tag: rec.tag, subs }, (p) => ({ x: p.x + dx, y: p.y + dy }), 0, { storage: 'ComponentBodies6' }) : { tag: rec.tag, subs };
      put(moved.subs[0]!, REGION.component, component);
      return { tag: rec.tag, subs: moved.subs };
    }
  }
  return { tag: rec.tag, subs };
}

/**
 * Footprint records that go onto a board: all but 3D bodies holding a STEP model, which would
 * also need the library's embedded model copied into the board (extruded, cylinder and sphere
 * bodies are complete in themselves).
 */
export function placeable(rec: PcbRawRecord): boolean {
  if (rec.tag !== PCB_TAG.MODEL) return true;
  const s = rec.subs[0];
  if (!s || s.length < REGION.propsAt + 4) return false;
  try {
    const len = new DataView(s.buffer, s.byteOffset, s.byteLength).getUint32(REGION.propsAt, true) & 0x00ffffff;
    return PropertyBag.parse(s.subarray(REGION.propsAt + 4, REGION.propsAt + 4 + len)).int('MODEL.MODELTYPE') !== 1;
  } catch { return false; }
}

export function footprintBounds(fp: Footprint): BBox {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const grow = (p: Vec2, r = 0) => { b.minX = Math.min(b.minX, p.x - r); b.minY = Math.min(b.minY, p.y - r); b.maxX = Math.max(b.maxX, p.x + r); b.maxY = Math.max(b.maxY, p.y + r); };
  for (const p of fp.prims) {
    switch (p.kind) {
      case 'track': grow(p.a, p.width / 2); grow(p.b, p.width / 2); break;
      case 'arc': grow(p.c, p.r + p.width / 2); break;
      case 'pad': grow(p.at, Math.max(p.top.w, p.top.h) / 2); break;
      case 'via': grow(p.at, p.diameter / 2); break;
      case 'fill': grow(p.a); grow(p.b); break;
      case 'region': for (const v of p.outline) grow(v); break;
      case 'text': grow(p.at, p.height); break;
    }
  }
  if (!(b.minX <= b.maxX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return b;
}

/* ─── Writing ────────────────────────────────────────────────────────────────────────── */

export interface FootprintDef { name: string; description?: string; height?: string; records: PcbRawRecord[]; /** More for its Parameters (an import's kept source). */ params?: Record<string, string> }

function pascalSub(s: string): Uint8Array {
  const b = binToBytes(toCp1252Lossy(s).slice(0, 255));
  return new BinWriter(b.length + 5).u32(b.length + 1).u8(b.length).bytes(b).finish();
}

/** Eight capital letters, as the id AD17 writes after the version in a library's FileHeader. */
const libId = () => Array.from({ length: 8 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

/**
 * A PCB library's FileHeader as AD17 writes it: u32 length, a Pascal string "PCB 6.0 Binary
 * Library File", the format version 5.01 (f64), then u32 + Pascal string holding an 8-letter id.
 * AD17 doesn't recognise a library without it (it shows one empty PCBCOMPONENT_1).
 */
export function pcbLibFileHeader(): Uint8Array {
  const text = binToBytes('PCB 6.0 Binary Library File'), id = binToBytes(libId());
  return new BinWriter(64).u32(text.length).u8(text.length).bytes(text).f64(5.01).u32(id.length).u8(id.length).bytes(id).finish();
}

/** A library holding the given footprints (Konium's own writer; see STATUS above). */
export function writePcbLib(defs: FootprintDef[], fileName = 'PcbLib1.PcbLib'): Uint8Array {
  const root = newEntry('Root Entry', 'root');
  cfbPut(root, 'FileHeader', pcbLibFileHeader());
  // The header with the board's whole layer system (with a few layer names only, AD17 showed one layer tab and multi-layer pads without copper)
  const props = newLibraryRecord(fileName);
  const pb = props.toBytes();
  const lib = new BinWriter(1024).u32(pb.length).bytes(pb).u32(defs.length);
  for (const d of defs) lib.bytes(pascalSub(d.name));
  cfbPut(root, 'Library/Header', countHeader(1));
  cfbPut(root, 'Library/Data', lib.finish());
  // The component list AD17 keeps beside it: one text record, a line per footprint (height in mils, no unit)
  const mils = (h: string | undefined) => { const v = parseLength(h ?? '') ?? 0; return String(+(v / UNITS_PER_MIL).toFixed(4)); };
  const toc = binToBytes(toCp1252Lossy(defs.map((d) => `Name=${d.name}|Pad Count=${d.records.filter((r) => r.tag === PCB_TAG.PAD).length}|Height=${mils(d.height)}|Description=${d.description ?? ''}\r\n`).join('')));
  cfbPut(root, 'Library/ComponentParamsTOC/Header', countHeader(1));
  cfbPut(root, 'Library/ComponentParamsTOC/Data', new BinWriter(toc.length + 4).u32(toc.length).bytes(toc).finish());
  // Storage names: the footprint's, made safe, unique (the library's own storages taken too)
  const used = new Set<string>(root.children.map((c) => c.name.toLowerCase()));
  for (const d of defs) {
    const base = d.name.replace(/[/\\:*?"<>|!]/g, '_') || 'Footprint';
    let st = base.slice(0, 31);
    for (let i = 1; used.has(st.toLowerCase()); i++) st = `${base.slice(0, 31 - String(i).length - 1)}_${i}`;
    used.add(st.toLowerCase());
    const params = PropertyBag.from({ PATTERN: d.name, HEIGHT: d.height ?? '0mil', DESCRIPTION: d.description ?? '', ...(d.params ?? {}) }).toBytes();
    cfbPut(root, `${st}/Header`, countHeader(d.records.length));
    cfbPut(root, `${st}/Parameters`, new BinWriter(params.length + 4).u32(params.length).bytes(params).finish());
    // No wide strings: one empty text record, as AD17 writes it
    cfbPut(root, `${st}/WideStrings`, new Uint8Array([1, 0, 0, 0, 0]));
    const data = new BinWriter(4096);
    data.bytes(pascalSub(d.name)).bytes(joinBinaryRecords(d.records));
    cfbPut(root, `${st}/Data`, data.finish());
  }
  return writeCfb(root);
}
