/**
 * OrCAD Capture designs (.DSN) and libraries (.OLB) read: the compound file's streams decoded
 * into pages, symbols, packages and the occurrence tree. Version 3 files (Capture 16 and later)
 * frame every structure with long prefixes (a type and the length to its end) and a short prefix
 * (the type and its properties as string indices); version 2 and older ones (Capture 9 and 10)
 * have the short prefix only, with 16-bit string indices. The framing follows KiCad's reading of
 * the format (orcad_dsn.ksy), itself from the OpenOrCadParser project. Coordinates are OrCAD's
 * unit (0.01 inch, AD's own), Y down.
 */
import { readCfb, type CfbEntry } from '../cfb/cfb';

export class OrError extends Error {}

/* ── the records ── */

export interface OrDisplayProp { name: string; x: number; y: number; rotation: number; fontIdx: number; color: number; dispMode: number }
export interface OrAlias { name: string; x: number; y: number; rotation: number; color: number; fontIdx: number }
export interface OrWire { dbId: number; netId: number; x1: number; y1: number; x2: number; y2: number; bus: boolean; color: number; lineWidth: number; lineStyle: number; aliases: OrAlias[] }
export interface OrPinInst { pinIndex: number; x: number; y: number; displayProps: OrDisplayProp[] }
export interface OrPlaced {
  pkgName: string; dbId: number; x: number; y: number; reference: string; value: string; props: Record<string, string>; displayProps: OrDisplayProp[];
  color: number; rotation: number; mirror: boolean; partIndex: number; bbox: Box; sourcePackage: string; sourceLibrary: string; unitIndex: number; pins: OrPinInst[];
}
export interface Box { x1: number; y1: number; x2: number; y2: number }
export type PrimKind = 'group' | 'rect' | 'line' | 'arc' | 'ellipse' | 'polygon' | 'polyline' | 'bezier' | 'text' | 'image';
export interface OrPrim {
  kind: PrimKind; x1: number; y1: number; x2: number; y2: number; start?: Pt; end?: Pt; points: Pt[]; text?: string; fontIdx: number;
  lineStyle: number; lineWidth: number; fillStyle: number; hatchStyle: number; data?: Uint8Array; children: OrPrim[];
}
export interface Pt { x: number; y: number }
export interface OrSymbolPin { name: string; position: number; startX: number; startY: number; hotX: number; hotY: number; portType: number; shapeBits: number; displayProps: OrDisplayProp[] }
export interface OrSymbol {
  typeId: number; name: string; sourceLib: string; color: number; prims: OrPrim[]; pins: OrSymbolPin[]; bbox?: Box; props: Record<string, string>;
  generalFlags: number; variants: OrSymbol[];
}
export interface OrGraphic {
  typeId: number; name: string; dbId: number; x: number; y: number; bbox: Box; color: number; props: Record<string, string>; displayProps: OrDisplayProp[];
  nested?: OrSymbol; rotation: number; mirror: boolean; logicalName: string;
}
export interface OrDevice { unitRef: string; refDes: string; pinNumbers: string[]; pinIgnore: boolean[] }
export interface OrPackage { name: string; sourceLib: string; refDes: string; pcbFootprint: string; devices: OrDevice[]; props: Record<string, string>; variants: OrPackage[] }
export interface OrBlockPin { name: string; portType: number; x: number; y: number; noConnect: boolean }
export interface OrBlock { dbId: number; name: string; reference: string; props: Record<string, string>; x1: number; y1: number; w: number; h: number; pins: OrBlockPin[]; displayProps: OrDisplayProp[]; childName: string; orientation: number }
export interface OrBusEntry { x1: number; y1: number; x2: number; y2: number; color: number }
export interface OrFont { height: number; width: number; escapement: number; bold: boolean; italic: boolean; face: string }
export interface OrPageSettings { width: number; height: number; pinToPin: number; isMetric: boolean; borderDisplayed: boolean; titleblockDisplayed: boolean; horizontalCount: number; verticalCount: number; horizontalWidth: number; verticalWidth: number; horizontalChar: boolean; verticalChar: boolean; horizontalAscending: boolean; verticalAscending: boolean }
export interface OrNetGroup { id: number; name: string; members: number[] }
export interface OrPage {
  name: string; pageSize: string; props: Record<string, string>; settings: OrPageSettings; titleBlocks: OrGraphic[]; wires: OrWire[]; instances: OrPlaced[];
  ports: OrGraphic[]; globals: OrGraphic[]; offpage: OrGraphic[]; busEntries: OrBusEntry[]; graphics: OrGraphic[]; nets: Map<number, string>; netGroups: OrNetGroup[]; blocks: OrBlock[];
}
export interface OrLibraryInfo { intro: string; major: number; minor: number; fonts: OrFont[]; templateFonts: number[]; partFields: string[]; strings: string[]; schematicName: string; pinToPin: number }
export interface OrScope { partRefs: Map<number, string>; partUnitRefs: Map<number, string>; partProps: Map<number, Record<string, string>>; netNames: Map<number, string>; blocks: { targetDbId: number; childFolder: string; scope: OrScope }[] }
export interface OrFolder { name: string; pages: OrPage[] }
export interface OrDesign {
  library: OrLibraryInfo; symbols: Map<string, OrSymbol>; packages: Map<string, OrPackage>; folders: OrFolder[]; root: string; occurrences?: OrScope; warnings: string[]; isLibrary: boolean;
}

/* ── the byte stream ── */

const PREAMBLE = [0xff, 0xe4, 0x5c, 0x39];
const cp1252 = new TextDecoder('windows-1252');

class Stream {
  pos = 0;
  size: number;
  private dv: DataView;
  nest = 0;
  constructor(readonly b: Uint8Array) { this.size = b.length; this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  need(n: number) { if (this.pos > this.size || n > this.size - this.pos) throw new OrError(`read of ${n} bytes past the end at 0x${this.pos.toString(16)}`); }
  u8() { this.need(1); return this.b[this.pos++]!; }
  u16() { this.need(2); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  i16() { this.need(2); const v = this.dv.getInt16(this.pos, true); this.pos += 2; return v; }
  u32() { this.need(4); const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  i32() { this.need(4); const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; }
  lzt(): string {
    const at = this.pos, len = this.u16();
    if (len + 1 > this.size - this.pos) throw new OrError(`string of ${len} at 0x${at.toString(16)} past the end`);
    const s = cp1252.decode(this.b.subarray(this.pos, this.pos + len));
    this.pos += len;
    if (this.b[this.pos] !== 0) throw new OrError(`string at 0x${at.toString(16)} unterminated`);
    this.pos++;
    return s;
  }
  bytes(n: number) { this.need(n); const v = this.b.slice(this.pos, this.pos + n); this.pos += n; return v; }
  skip(n: number) { if (this.pos > this.size || n > this.size - this.pos) throw new OrError(`skip of ${n} past the end at 0x${this.pos.toString(16)}`); this.pos += n; }
  seek(p: number) { if (p > this.size) throw new OrError(`seek past the end to 0x${p.toString(16)}`); this.pos = p; }
  peek(ahead = 0) { const p = this.pos + ahead; return p >= this.size ? -1 : this.b[p]!; }
  matches(bytes: number[], ahead = 0) { const p = this.pos + ahead; if (p > this.size || bytes.length > this.size - p) return false; return bytes.every((v, i) => this.b[p + i] === v); }
  expect(v: number, what: string) { const g = this.u8(); if (g !== v) throw new OrError(`expected ${v} got ${g} (${what}) at 0x${(this.pos - 1).toString(16)}`); }
  get remaining() { return this.size - this.pos; }
  /** Runs f with the stream ending at `end`. */
  within<T>(end: number, f: () => T): T {
    if (end > this.size || end < this.pos) throw new OrError(`bad record bound 0x${end.toString(16)} at 0x${this.pos.toString(16)}`);
    const saved = this.size;
    this.size = end;
    try { return f(); } finally { this.size = saved; }
  }
  nested<T>(f: () => T): T { if (this.nest >= 64) throw new OrError('nested too deep'); this.nest++; try { return f(); } finally { this.nest--; } }
  skipOptionalPreamble() { if (this.matches(PREAMBLE)) { this.skip(4); this.skip(this.u32()); } }
}

/** Long prefixes a structure type carries (version 3). */
function longPrefixCount(t: number): number | undefined {
  if ([9, 66, 67, 68, 69, 82, 91].includes(t)) return 1;
  if ([10, 16, 17, 20, 21, 26, 27, 29, 32, 37, 38, 39, 48, 49, 55, 56, 57, 58, 59, 60, 61, 62, 88, 89].includes(t)) return 2;
  if ([2, 6, 12, 23, 31, 65, 77].includes(t)) return 3;
  if ([13, 33, 34, 35, 64, 75, 76].includes(t)) return 4;
  if (t === 24) return 5;
  return undefined;
}

interface Prefixes { start: number; typeId: number; props: [number, number][]; bodyStart: number; stops: number[]; end: number }
interface Dialect { legacy: boolean; shortDisplay: boolean }

const ST = { STH_IN_PAGES0: 2, PART_CELL: 6, SCH_LIB: 9, PAGE: 10, DRAWN_INSTANCE: 12, PLACED_INSTANCE: 13, PIN_INST: 16, PIN_INST_BUS: 17, WIRE: 20, WIRE_BUS: 21, PORT: 23, LIBRARY_PART: 24,
  PIN: 26, PIN_BUS: 27, BUS_ENTRY: 29, PACKAGE: 31, DEVICE: 32, GLOBAL_SYMBOL: 33, PORT_SYMBOL: 34, OFFPAGE_SYMBOL: 35, GLOBAL: 37, OFFPAGE: 38, DISPLAY_PROP: 39,
  SYMBOL_VECTOR: 48, ALIAS: 49, TITLEBLOCK_SYMBOL: 64, TITLEBLOCK: 65, ERC_SYMBOL: 75, BOOKMARK_SYMBOL: 76, ERC_OBJECT: 77 } as const;
const GRAPHIC_TYPES = new Set([37, 38, 55, 56, 57, 58, 59, 60, 61, 62, 88, 89]);
const SYMBOL_TYPES = new Set([24, 33, 34, 35, 64, 75, 76]);
const PRIM_TYPES = new Set([40, 41, 42, 43, 44, 45, 46, 47, 48, 87, 90]);

type Record_ = { t: 'wire'; v: OrWire } | { t: 'alias'; v: OrAlias } | { t: 'display'; v: OrDisplayProp } | { t: 'placed'; v: OrPlaced } | { t: 'graphic'; v: OrGraphic }
  | { t: 'busentry'; v: OrBusEntry } | { t: 'pin'; v: OrPinInst } | { t: 'symbol'; v: OrSymbol } | { t: 'block'; v: OrBlock } | { t: 'none' };

class Reader {
  constructor(readonly s: Stream, readonly strings: string[], readonly d: Dialect, readonly warn: (w: string) => void = () => {}) {}

  resolve(i: number): string { if (this.d.legacy && i === 0xffff) return ''; return i < this.strings.length ? this.strings[i]! : ''; }
  strIdx() { return this.d.legacy ? this.s.u16() : this.s.u32(); }
  count(): number {
    const c = this.s.u16();
    if (this.d.legacy && (c > 30000 || c > this.s.remaining)) throw new OrError(`legacy count ${c} beyond what remains`);
    return c;
  }
  propsOf(p: Prefixes): Record<string, string> {
    const o: Record<string, string> = {};
    for (const [a, b] of p.props) { const k = this.resolve(a); if (k || this.d.legacy) o[k] = this.resolve(b); }
    return o;
  }

  prefixes(expected = -1, enclosingEnd = -1, longCount = -1): Prefixes {
    const s = this.s;
    const start = s.pos;
    if (this.d.legacy) {
      const typeId = s.u8();
      if (expected >= 0 && typeId !== expected) throw new OrError(`expected type ${expected}, got ${typeId}`);
      const n = s.i16();
      if (n > 1000) throw new OrError(`legacy prefix: ${n} properties`);
      const props: [number, number][] = [];
      for (let i = 0; i < n; i++) props.push([s.u16(), s.u16()]);
      return { start, typeId, props, bodyStart: s.pos, stops: [], end: 0 };
    }
    const typeId = s.peek();
    if (typeId < 0) throw new OrError('missing structure type');
    if (expected >= 0 && typeId !== expected) throw new OrError(`expected type ${expected}, got ${typeId} at 0x${start.toString(16)}`);
    const lc = longCount >= 0 ? longCount : longPrefixCount(typeId);
    if (!lc) throw new OrError(`unregistered structure type ${typeId}`);
    const bound = enclosingEnd >= 0 ? enclosingEnd : s.size;
    const lens: number[] = [];
    for (let i = 0; i < lc; i++) {
      const t = s.u8();
      if (t !== typeId) throw new OrError(`prefix type ${t} ≠ ${typeId}`);
      lens.push(s.u32());
      if (s.u32() !== 0) throw new OrError('long prefix pad not zero');
    }
    if (s.u8() !== typeId) throw new OrError('short prefix type mismatch');
    const n = s.i16();
    const props: [number, number][] = [];
    for (let i = 0; i < n; i++) props.push([s.u32(), s.u32()]);
    for (const v of PREAMBLE) s.expect(v, 'preamble');
    s.skip(s.u32());
    const bodyStart = s.pos;
    const stops = lens.map((len, i) => {
      const stop = start + 9 * i + 9 + len;
      if (stop < bodyStart || stop > bound) throw new OrError(`stop 0x${stop.toString(16)} outside its bound`);
      return stop;
    });
    return { start, typeId, props, bodyStart, stops, end: stops[0]! };
  }

  skipStructure(p: Prefixes) { if (p.end && p.end >= this.s.pos) this.s.seek(p.end); else throw new OrError('cannot skip structure'); }

  structure(): Record_ {
    const s = this.s;
    return s.nested(() => {
      const start = s.pos;
      const p = this.prefixes();
      let rec: Record_ = { t: 'none' };
      try {
        const body = () => {
          switch (p.typeId) {
            case ST.WIRE: case ST.WIRE_BUS: rec = { t: 'wire', v: this.wire(p) }; break;
            case ST.ALIAS: rec = { t: 'alias', v: this.alias() }; break;
            case ST.DISPLAY_PROP: rec = { t: 'display', v: this.displayProp() }; break;
            case ST.PLACED_INSTANCE: rec = { t: 'placed', v: this.placed(p) }; break;
            case ST.PORT: case ST.TITLEBLOCK: case ST.ERC_OBJECT:
              rec = { t: 'graphic', v: this.graphic(p) };
              if (this.d.legacy && p.typeId === ST.ERC_OBJECT) { s.lzt(); s.lzt(); s.lzt(); }
              else if (this.d.legacy) s.skip(p.typeId === ST.PORT ? 9 : 12);
              break;
            case ST.BUS_ENTRY: rec = { t: 'busentry', v: this.busEntry() }; break;
            case ST.PIN_INST: case ST.PIN_INST_BUS: rec = { t: 'pin', v: this.pinInst() }; break;
            case ST.STH_IN_PAGES0: rec = { t: 'symbol', v: this.symbolDef(p, false) }; break;
            case ST.DRAWN_INSTANCE: rec = { t: 'block', v: this.drawnInstance(p) }; break;
            default:
              if (GRAPHIC_TYPES.has(p.typeId)) { rec = { t: 'graphic', v: this.graphic(p) }; break; }
              if (this.d.legacy) throw new OrError(`legacy structure: type ${p.typeId} not handled`);
          }
        };
        if (p.end) s.within(p.end, body); else body();
      } catch (e) {
        if (p.end && p.end > start) { this.warn(`structure type ${p.typeId} at 0x${start.toString(16)}: ${(e as Error).message}; skipped`); s.seek(p.end); return { t: 'none' } as Record_; }
        throw e;
      }
      if (p.end && s.pos < p.end) s.seek(p.end);
      return rec;
    });
  }

  displayProp(): OrDisplayProp {
    const s = this.s;
    const name = this.resolve(this.strIdx());
    const x = s.i16(), y = s.i16();
    const rf = s.u16();
    let color = 0, dispMode = 0x100;
    if (this.d.shortDisplay) { s.u8(); color = s.u8(); }
    else { color = s.u8(); dispMode = s.u16(); s.expect(0, 'display prop tail'); }
    return { name, x, y, fontIdx: rf & 0x3fff, rotation: (rf >> 14) & 3, color, dispMode };
  }
  displayProps(): OrDisplayProp[] {
    const out: OrDisplayProp[] = [];
    const n = this.count();
    for (let i = 0; i < n; i++) { const r = this.structure(); if (r.t === 'display') out.push(r.v); }
    return out;
  }
  alias(): OrAlias {
    const s = this.s;
    const x = s.i32(), y = s.i32(), color = s.u32(), rotation = s.u32() & 3, fontIdx = s.u32();
    return { x, y, color, rotation, fontIdx, name: s.lzt() };
  }
  wire(p: Prefixes): OrWire {
    const s = this.s;
    const dbId = s.u32(), netId = s.u32(), color = s.u32();
    const x1 = s.i32(), y1 = s.i32(), x2 = s.i32(), y2 = s.i32();
    s.skip(1);
    const aliases: OrAlias[] = [];
    const na = s.u16();
    for (let i = 0; i < na; i++) { const r = this.structure(); if (r.t === 'alias') aliases.push(r.v); }
    const np = s.u16();
    for (let i = 0; i < np; i++) this.structure();
    let lineWidth = 3, lineStyle = 5;
    if (!this.d.legacy) { lineWidth = s.u32(); lineStyle = s.u32(); }
    return { dbId, netId, color, x1, y1, x2, y2, bus: p.typeId === ST.WIRE_BUS, lineWidth, lineStyle, aliases };
  }
  placed(p: Prefixes): OrPlaced {
    const s = this.s;
    this.strIdx();
    const sourceLibrary = this.resolve(this.strIdx());
    if (this.d.legacy) s.skip(4);
    const pkgName = s.lzt(), dbId = s.u32();
    const by1 = s.i16(), bx1 = s.i16(), by2 = s.i16(), bx2 = s.i16();
    const x = s.i16(), y = s.i16(), color = s.u8(), o = s.u8(), partIndex = s.u8();
    s.u8();
    const displayProps = this.displayProps();
    s.skip(1);
    const reference = s.lzt();
    const value = this.resolve(this.strIdx());
    s.skip(this.d.legacy ? 6 : 10);
    const pins: OrPinInst[] = [];
    const np = s.u16();
    for (let i = 0; i < np; i++) { const r = this.structure(); if (r.t === 'pin') pins.push(r.v); }
    const sourcePackage = s.lzt(), unitIndex = s.u16();
    return { pkgName, dbId, x, y, reference, value, props: this.propsOf(p), displayProps, color, rotation: o & 3, mirror: (o & 4) !== 0, partIndex, bbox: { x1: bx1, y1: by1, x2: bx2, y2: by2 }, sourcePackage, sourceLibrary, unitIndex, pins };
  }
  graphic(p: Prefixes): OrGraphic {
    const s = this.s;
    const nameIdx = this.strIdx(), libIdx = this.strIdx();
    if (this.d.legacy) s.skip(4);
    const name = s.lzt(), dbId = s.u32();
    const y = s.i16(), x = s.i16(), y2 = s.i16(), x2 = s.i16(), x1 = s.i16(), y1 = s.i16();
    const color = s.u8(), o = s.u8();
    s.skip(2);
    const displayProps = this.displayProps();
    let nested: OrSymbol | undefined;
    if (s.u8() === 2) { const r = this.structure(); if (r.t === 'symbol') nested = r.v; }
    const props = this.propsOf(p);
    const lib = this.resolve(libIdx);
    if (this.d.legacy && lib) props['Source Library'] = lib;
    return { typeId: p.typeId, name, dbId, x, y, bbox: { x1, y1, x2, y2 }, color, props, displayProps, nested, rotation: o & 3, mirror: (o & 4) !== 0, logicalName: this.resolve(nameIdx) };
  }
  pinInst(): OrPinInst {
    const s = this.s;
    const pinIndex = s.i16(), x = s.i16(), y = s.i16();
    s.u32(); s.u32();
    return { pinIndex, x, y, displayProps: this.displayProps() };
  }
  busEntry(): OrBusEntry {
    const s = this.s;
    const color = s.u32(), x1 = s.i32(), y1 = s.i32(), x2 = s.i32(), y2 = s.i32();
    s.skip(8);
    return { color, x1, y1, x2, y2 };
  }

  /* ── symbols: primitives, pins ── */

  primFields(t: number, pr: OrPrim): boolean {
    const s = this.s;
    switch (t) {
      case 40: case 43:
        pr.kind = t === 40 ? 'rect' : 'ellipse';
        pr.x1 = s.i32(); pr.y1 = s.i32(); pr.x2 = s.i32(); pr.y2 = s.i32();
        pr.lineStyle = s.u32(); pr.lineWidth = s.u32(); pr.fillStyle = s.u32(); pr.hatchStyle = s.u32();
        return true;
      case 41:
        pr.kind = 'line';
        pr.x1 = s.i32(); pr.y1 = s.i32(); pr.x2 = s.i32(); pr.y2 = s.i32();
        pr.lineStyle = s.u32(); pr.lineWidth = s.u32();
        return true;
      case 42:
        pr.kind = 'arc';
        pr.x1 = s.i32(); pr.y1 = s.i32(); pr.x2 = s.i32(); pr.y2 = s.i32();
        pr.start = { x: s.i32(), y: s.i32() }; pr.end = { x: s.i32(), y: s.i32() };
        pr.lineStyle = s.u32(); pr.lineWidth = s.u32();
        return true;
      case 44: case 45: case 87: {
        pr.kind = t === 44 ? 'polygon' : t === 87 ? 'bezier' : 'polyline';
        pr.lineStyle = s.u32(); pr.lineWidth = s.u32();
        if (t === 44) { pr.fillStyle = s.u32(); pr.hatchStyle = s.u32(); }
        const n = s.u16();
        for (let i = 0; i < n; i++) { const y = s.i16(), x = s.i16(); pr.points.push({ x, y }); }
        return true;
      }
      case 46:
        pr.kind = 'text';
        pr.x1 = s.i32(); pr.y1 = s.i32(); pr.x2 = s.i32(); pr.y2 = s.i32();
        pr.start = { x: s.i32(), y: s.i32() };
        pr.fontIdx = s.u16(); s.skip(2);
        pr.text = s.lzt();
        return true;
      case 47:
        pr.kind = 'image';
        pr.x1 = s.i32(); pr.y1 = s.i32(); pr.x2 = s.i32(); pr.y2 = s.i32();
        s.skip(16);
        pr.data = s.bytes(s.u32());
        return true;
      default: return false;
    }
  }
  primBody(t: number): OrPrim | undefined {
    const s = this.s;
    const start = s.pos, size = s.u32(), available = s.size - start;
    if (size > available) throw new OrError(`primitive ${t} at 0x${start.toString(16)} beyond its structure`);
    let recordSize = size;
    if (t !== 90 && available - size >= 8) recordSize += 8;
    let pr: OrPrim | undefined;
    s.within(start + recordSize, () => {
      for (let i = 0; i < 4; i++) s.expect(0, 'primitive pad');
      const p = newPrim();
      if (t === 90) {
        p.kind = 'image';
        p.x1 = s.i32(); p.y1 = s.i32(); p.x2 = s.i32(); p.y2 = s.i32();
        s.skip(16);
        const from = s.pos, to = start + size;
        if (to < from) throw new OrError('OLE primitive shorter than its header');
        p.data = s.b.slice(from, to);
        s.seek(to);
        pr = p;
      } else if (this.primFields(t, p)) pr = p;
      if (t === 46) s.seek(start + recordSize);
      else {
        const used = s.pos - start;
        if (!(t === 90 ? size === used : size === used || size + 8 === used)) throw new OrError(`primitive ${t} says ${size} bytes, used ${used}`);
      }
    });
    s.skipOptionalPreamble();
    return pr;
  }
  symbolVector(): OrPrim {
    const s = this.s;
    return s.nested(() => {
      const r = new Reader(s, this.strings, this.d);
      const p = r.prefixes(ST.SYMBOL_VECTOR, -1, 1);
      const g = newPrim();
      g.kind = 'group';
      s.within(p.end, () => {
        g.x1 = s.i16(); g.y1 = s.i16();
        const n = s.u16();
        for (let i = 0; i < n; i++) {
          const t = s.u8();
          s.expect(0, 'symbol vector pad');
          if (!PRIM_TYPES.has(t)) throw new OrError('symbol vector primitive type');
          let c: OrPrim | undefined;
          if (t === 48) c = this.symbolVector();
          else { if (s.u8() !== t) throw new OrError('symbol vector primitive prefix'); c = this.primBody(t); }
          if (c) g.children.push(c);
        }
        s.lzt();
        if (p.end) s.seek(Math.max(s.pos, p.end));
      });
      return g;
    });
  }
  legacyVector(): OrPrim {
    const s = this.s;
    return s.nested(() => {
      s.expect(48, 'legacy vector');
      const np = s.i16();
      s.skip(4 * Math.max(np, 0));
      const g = newPrim();
      g.kind = 'group';
      g.x1 = s.i16(); g.y1 = s.i16();
      const n = this.count();
      for (let i = 0; i < n; i++) { const t = s.u8(); s.expect(0, 'legacy vector pad'); g.children.push(this.legacyPrim(t)); }
      s.lzt();
      return g;
    });
  }
  legacyPrim(t: number): OrPrim {
    if (t === 48) return this.legacyVector();
    const p = newPrim();
    if (!this.primFields(t, p)) throw new OrError(`legacy primitive ${t} not handled at 0x${this.s.pos.toString(16)}`);
    return p;
  }
  primitive(): OrPrim | undefined {
    const s = this.s;
    const t = s.u8();
    if (this.d.legacy) return this.legacyPrim(t);
    if (!PRIM_TYPES.has(t)) throw new OrError(`bad primitive type ${t} at 0x${(s.pos - 1).toString(16)}`);
    if (t === 48) return this.symbolVector();
    if (s.u8() !== t) throw new OrError(`bad primitive prefix at 0x${(s.pos - 2).toString(16)}`);
    return this.primBody(t);
  }
  symbolPin(): OrSymbolPin | null {
    const s = this.s;
    if (s.peek() === 0) { s.skip(1); return null; }
    const p = this.prefixes();
    if (p.typeId !== ST.PIN && p.typeId !== ST.PIN_BUS) throw new OrError(`expected a symbol pin, got ${p.typeId}`);
    const name = s.lzt();
    const startX = s.i32(), startY = s.i32(), hotX = s.i32(), hotY = s.i32(), shapeBits = s.u16();
    s.skip(2);
    const pt = s.u32();
    let displayProps: OrDisplayProp[] = [];
    if (this.d.legacy || (p.end && p.end >= s.pos + 6 && s.peek() === p.typeId)) { s.expect(p.typeId, 'pin type echo'); s.skip(3); displayProps = this.displayProps(); }
    if (p.end && p.end >= s.pos) s.seek(p.end);
    return { name, position: -1, startX, startY, hotX, hotY, shapeBits, portType: pt <= 7 ? pt : 4, displayProps };
  }
  symbolDef(p: Prefixes, withPins: boolean): OrSymbol {
    const s = this.s;
    const stops = [...p.stops].sort((a, b) => a - b);
    const sym: OrSymbol = { typeId: p.typeId, name: s.lzt(), sourceLib: s.lzt(), color: 0, prims: [], pins: [], props: this.propsOf(p), generalFlags: -1, variants: [] };
    sym.color = s.u32();
    const n = this.count();
    for (let i = 0; i < n; i++) {
      const pr = this.primitive();
      if (pr) sym.prims.push(pr);
      if (i + 1 < n && s.matches([0, 0, 0, 0, 0, 0, 0, 0])) s.skip(8);
    }
    if (this.d.legacy) {
      if (withPins || !this.d.shortDisplay) sym.bbox = { x1: s.i16(), y1: s.i16(), x2: s.i16(), y2: s.i16() };
    } else {
      const next = stops.find((x) => x > s.pos);
      if (next !== undefined) {
        const gap = next - s.pos;
        if (gap >= 8) {
          s.seek(next - 8);
          const x1 = s.i16(), y1 = s.i16(), x2 = s.i16(), y2 = s.i16();
          if (x1 <= x2 && y1 <= y2 && x2 - x1 <= 4000 && y2 - y1 <= 4000) sym.bbox = { x1, y1, x2, y2 };
        } else if (gap > 0) s.seek(next);
      }
    }
    if (withPins) {
      const np = this.count();
      for (let i = 0; i < np; i++) { const pin = this.symbolPin(); if (pin) { pin.position = i; sym.pins.push(pin); } }
      const nprops = this.count();
      for (let i = 0; i < nprops; i++) this.structure();
      if (sym.typeId === ST.LIBRARY_PART && p.stops.length >= 2) {
        const save = s.pos, tail = p.stops[1]!;
        if (s.pos === tail && tail < p.end) {
          try {
            const implPath = s.lzt(), impl = s.lzt();
            s.lzt(); s.lzt();
            const flags = s.u16();
            if (s.pos === p.end) {
              if (implPath) sym.props['Implementation Path'] = implPath;
              if (impl) sym.props.Implementation = impl;
              sym.generalFlags = flags;
            }
          } catch { /* not the tail */ }
        }
        s.seek(save);
      }
    }
    if (p.end && p.end > s.pos) s.seek(p.end);
    return sym;
  }
  drawnInstance(p: Prefixes): OrBlock {
    const s = this.s;
    const nameIdx = this.strIdx();
    this.strIdx();
    if (this.d.legacy) s.skip(4);
    s.lzt();
    const dbId = s.u32();
    s.i16(); s.i16(); s.i16(); s.i16();
    const x1 = s.i16(), y1 = s.i16();
    s.u8();
    const orientation = s.u8();
    s.skip(2);
    const displayProps = this.displayProps();
    const flag = s.u8();
    if (flag !== ST.LIBRARY_PART) throw new OrError(`drawn instance nested flag ${flag}`);
    const np = this.prefixes(ST.LIBRARY_PART, p.end || -1);
    const nested = this.symbolDef(np, true);
    const bb = nested.bbox ?? { x1: 0, y1: 0, x2: 0, y2: 0 };
    const quarter = (orientation & 1) !== 0;
    const block: OrBlock = { dbId, name: this.resolve(nameIdx), reference: '', props: this.propsOf(p), x1, y1, w: quarter ? bb.y2 - bb.y1 : bb.x2 - bb.x1, h: quarter ? bb.x2 - bb.x1 : bb.y2 - bb.y1, pins: [], displayProps, childName: '', orientation };
    if (this.d.legacy) {
      Object.assign(block.props, nested.props);
      s.skip(14);
      block.reference = s.lzt();
      const valueIdx = this.strIdx(); this.strIdx();
      const implIdx = this.strIdx(); this.strIdx();
      block.props.Value = this.resolve(valueIdx);
      block.props.Implementation = this.resolve(implIdx);
    } else {
      const stops = [...p.stops].sort((a, b) => a - b);
      if (stops.length >= 2 && stops[stops.length - 2]! >= s.pos) s.seek(stops[stops.length - 2]!);
      block.reference = s.lzt();
      s.skip(14);
    }
    const n = this.count();
    const placed: OrPinInst[] = [];
    for (let i = 0; i < n; i++) { const r = this.structure(); if (r.t === 'pin') placed.push(r.v); }
    block.pins = blockPins(orientation, x1, y1, nested, placed);
    return block;
  }

  device(): OrDevice {
    const s = this.s;
    const p = this.prefixes(ST.DEVICE);
    const d: OrDevice = { unitRef: s.lzt(), refDes: s.lzt(), pinNumbers: [], pinIgnore: [] };
    const n = this.count();
    for (let i = 0; i < n; i++) {
      if (s.matches([0xff, 0xff])) { s.skip(2); d.pinNumbers.push(''); d.pinIgnore.push(true); continue; }
      d.pinNumbers.push(s.lzt());
      d.pinIgnore.push((s.u8() & 0x80) !== 0);
    }
    if (p.end && p.end > s.pos) s.seek(p.end);
    return d;
  }
  package(p: Prefixes): OrPackage {
    const s = this.s;
    const pkg: OrPackage = { name: s.lzt(), sourceLib: s.lzt(), refDes: s.lzt(), pcbFootprint: '', devices: [], props: {}, variants: [] };
    s.lzt();
    pkg.pcbFootprint = s.lzt();
    const n = this.count();
    for (let i = 0; i < n; i++) pkg.devices.push(this.device());
    pkg.props = this.propsOf(p);
    if (p.end && p.end > s.pos) s.seek(p.end);
    return pkg;
  }
}

function newPrim(): OrPrim { return { kind: 'line', x1: 0, y1: 0, x2: 0, y2: 0, points: [], fontIdx: 0, lineStyle: 5, lineWidth: 3, fillStyle: 1, hatchStyle: 0, children: [] }; }

/* ── orientation: OrCAD keeps the turned symbol's box where the unturned one was ── */

/** Indexed by OrCAD's orientation bits (0–1 quarter turns, 2 mirror): the offset selectors (0 none, 1 width, 2 height) and the matrix. */
export const ORIENT: { tx: number; ty: number; a: number; b: number; c: number; d: number }[] = [
  { tx: 0, ty: 0, a: 1, b: 0, c: 0, d: 1 }, { tx: 0, ty: 1, a: 0, b: 1, c: -1, d: 0 }, { tx: 1, ty: 2, a: -1, b: 0, c: 0, d: -1 }, { tx: 2, ty: 0, a: 0, b: -1, c: 1, d: 0 },
  { tx: 1, ty: 0, a: -1, b: 0, c: 0, d: 1 }, { tx: 0, ty: 0, a: 0, b: 1, c: 1, d: 0 }, { tx: 0, ty: 2, a: 1, b: 0, c: 0, d: -1 }, { tx: 2, ty: 1, a: 0, b: -1, c: -1, d: 0 },
];
const dim = (sel: number, w: number, h: number) => (sel === 1 ? w : sel === 2 ? h : 0);
/** A symbol point (px, py) on the page, for orientation `o` and the symbol's box w × h at base (x, y). */
export function orientPoint(o: number, w: number, h: number, x: number, y: number, px: number, py: number): Pt {
  const e = ORIENT[o & 7]!;
  return { x: x + dim(e.tx, w, h) + e.a * px + e.b * py, y: y + dim(e.ty, w, h) + e.c * px + e.d * py };
}

function blockPins(o: number, x1: number, y1: number, def: OrSymbol, placed: OrPinInst[]): OrBlockPin[] {
  const box = def.bbox ?? { x1: 0, y1: 0, x2: 0, y2: 0 };
  const placedPts = new Set(placed.map((p) => `${p.x},${p.y}`));
  const defPts = new Set(def.pins.map((p) => `${p.hotX},${p.hotY}`));
  const useDef = placedPts.size <= 1 && defPts.size > 1;
  const out: OrBlockPin[] = [];
  placed.forEach((pl, i) => {
    const slot = pl.pinIndex ? Math.abs(pl.pinIndex) - 1 : i;
    const d = def.pins.find((q) => q.position === slot);
    if (!d) return;
    const pin: OrBlockPin = { name: d.name, portType: d.portType, x: pl.x, y: pl.y, noConnect: pl.pinIndex < 0 };
    if (useDef) { const q = orientPoint(o, box.x2 - box.x1, box.y2 - box.y1, x1, y1, d.hotX - box.x1, d.hotY - box.y1); pin.x = q.x; pin.y = q.y; }
    out.push(pin);
  });
  return out;
}

/* ── streams ── */

function pageSettings(s: Stream): OrPageSettings {
  s.u32(); s.u32(); s.skip(16);
  const width = s.u32(), height = s.u32(), pinToPin = s.u32();
  s.skip(2);
  const horizontalCount = s.u16(), verticalCount = s.u16();
  s.skip(2);
  const horizontalWidth = s.u32(), verticalWidth = s.u32();
  s.skip(48);
  const horizontalChar = s.u32() !== 0;
  s.skip(4);
  const horizontalAscending = s.u32() !== 0, verticalChar = s.u32() !== 0;
  s.skip(4);
  const verticalAscending = s.u32() !== 0;
  const f = Array.from({ length: 8 }, () => s.u32());
  return { width, height, pinToPin, horizontalCount, verticalCount, horizontalWidth, verticalWidth, horizontalChar, horizontalAscending, verticalChar, verticalAscending, isMetric: f[0] !== 0, borderDisplayed: f[1] !== 0, titleblockDisplayed: f[5] !== 0 };
}

function parseLibrary(b: Uint8Array): OrLibraryInfo {
  const s = new Stream(b);
  let e = 0;
  while (e < 32 && b[e] !== 0) e++;
  const intro = cp1252.decode(b.subarray(0, e));
  s.seek(32);
  const major = s.u16(), minor = s.u16();
  s.u32(); s.u32(); s.skip(4);
  const fonts: OrFont[] = [];
  const nf = s.u16();
  for (let i = 0; i < nf - 1; i++) {
    const height = s.i32(), width = s.i32(), escapement = s.i32();
    s.i32();
    const bold = s.i32() >= 600, italic = s.u8() !== 0;
    s.skip(6); s.u8();
    const face = s.bytes(32);
    let k = 0;
    while (k < 32 && face[k] !== 0) k++;
    fonts.push({ height, width, escapement, bold, italic, face: cp1252.decode(face.subarray(0, k)) });
  }
  const nt = major >= 2 ? s.u16() : 17;
  const templateFonts = Array.from({ length: nt }, () => s.u16());
  s.skip(8);
  const partFields = Array.from({ length: 8 }, () => s.lzt());
  const ps = pageSettings(s);
  const ns = major < 3 ? s.u16() : s.u32();
  if (ns > 2000000 || ns * 3 > s.remaining + 16) throw new OrError(`string table of ${ns} does not fit`);
  const strings: string[] = [];
  for (let i = 0; i < ns; i++) strings.push(s.lzt());
  let schematicName = '';
  try {
    const na = s.u16();
    if (na * 2 <= s.remaining + 4) for (let i = 0; i < na; i++) { s.lzt(); s.lzt(); }
    if (intro.startsWith('OrCAD Windows Design')) { s.skip(8); schematicName = s.lzt(); }
  } catch { /* optional */ }
  return { intro, major, minor, fonts, templateFonts, partFields, strings, schematicName, pinToPin: ps.pinToPin };
}

function addOrVariant<T extends { name: string; variants: T[] }>(m: Map<string, T>, v: T) {
  const ex = m.get(v.name);
  if (ex) ex.variants.push(v); else m.set(v.name, v);
}

function parseCache(b: Uint8Array, strings: string[], d: Dialect, warn: (w: string) => void, symbols: Map<string, OrSymbol>, packages: Map<string, OrPackage>) {
  const s = new Stream(b), r = new Reader(s, strings, d, warn);
  try {
    if (s.u16() !== 0) throw new OrError('bad cache marker');
    for (let section = 0; section < 4; section++) {
      const groups = r.count();
      for (let g = 0; g < groups; g++) {
        s.lzt();
        const nv = r.count();
        for (let v = 0; v < nv; v++) {
          s.lzt(); s.u32(); s.u32();
          const t = s.u8();
          s.expect(0, 'cache entry pad');
          if (d.legacy) { legacyCacheRecord(r, t, symbols, packages); continue; }
          const ok = section === 0 ? t !== 24 && SYMBOL_TYPES.has(t) : section === 1 ? t === 24 : section === 2 ? t === ST.PART_CELL : t === ST.PACKAGE;
          if (!ok) throw new OrError(`cache section ${section} cannot hold type ${t}`);
          const p = r.prefixes(t);
          if (!p.end || p.end > s.size) throw new OrError('cache entry beyond the stream');
          try {
            s.within(p.end, () => {
              if (SYMBOL_TYPES.has(p.typeId)) addOrVariant(symbols, r.symbolDef(p, true));
              else if (p.typeId === ST.PACKAGE) addOrVariant(packages, r.package(p));
              else r.skipStructure(p);
            });
          } catch (e) { warn(`cache entry type ${t} at 0x${p.start.toString(16)}: ${(e as Error).message}`); }
          s.seek(p.end);
        }
      }
    }
  } catch (e) {
    warn(`Cache read only to 0x${s.pos.toString(16)} (${(e as Error).message}): later symbols drawn as boxes`);
  }
}

function legacyTail(s: Stream, def: OrSymbol): string {
  const implPath = s.lzt();
  if (implPath) def.props['Implementation Path'] = implPath;
  s.lzt();
  const prefix = s.lzt();
  s.lzt();
  def.generalFlags = s.u16();
  return prefix;
}

function legacyCacheRecord(r: Reader, t: number, symbols: Map<string, OrSymbol>, packages: Map<string, OrPackage>) {
  const s = r.s;
  const p = r.prefixes();
  if (t === ST.PART_CELL) { s.lzt(); s.lzt(); const n = r.count(); for (let i = 0; i < n; i++) s.lzt(); }
  else if (t === ST.PACKAGE) addOrVariant(packages, r.package(p));
  else {
    const def = r.symbolDef(p, true);
    if (t === ST.LIBRARY_PART) legacyTail(s, def);
    if (def.name) addOrVariant(symbols, def);
  }
}

function parsePackageStream(b: Uint8Array, strings: string[], d: Dialect, symbols: Map<string, OrSymbol>, packages: Map<string, OrPackage>) {
  const s = new Stream(b), r = new Reader(s, strings, d);
  let prefix = '';
  const nc = r.count();
  if (nc > 1000) throw new OrError('implausible part cell count');
  for (let i = 0; i < nc; i++) {
    const cp = r.prefixes(ST.PART_CELL);
    const cellProps = r.propsOf(cp);
    s.lzt(); s.lzt();
    const nv = r.count();
    for (let v = 0; v < nv; v++) s.lzt();
    if (!d.legacy) { if (!cp.end || s.pos > cp.end) throw new OrError('part cell beyond its frame'); s.seek(cp.end); }
    const nsym = r.count();
    let cellPrefix = '';
    for (let k = 0; k < nsym; k++) {
      const sp = r.prefixes(ST.LIBRARY_PART);
      const sym = r.symbolDef(sp, true);
      if (d.legacy) cellPrefix = legacyTail(s, sym);
      for (const [a, v] of Object.entries(cellProps)) if (!(a in sym.props)) sym.props[a] = v;
      if (!d.legacy || sym.name) addOrVariant(symbols, sym);
    }
    if (!prefix) prefix = cellPrefix;
  }
  const pp = r.prefixes(ST.PACKAGE);
  const pkg = r.package(pp);
  if (s.remaining) throw new OrError('package stream: trailing bytes');
  if (!pkg.refDes) pkg.refDes = prefix;
  if (!d.legacy || pkg.name) addOrVariant(packages, pkg);
}

function parseSymbolStream(b: Uint8Array, strings: string[], d: Dialect, symbols: Map<string, OrSymbol>) {
  const s = new Stream(b), r = new Reader(s, strings, d);
  const p = r.prefixes();
  if (d.legacy) {
    const def = r.symbolDef(p, true);
    if (def.typeId === ST.LIBRARY_PART && s.remaining) legacyTail(s, def);
    if (def.name) addOrVariant(symbols, def);
    return;
  }
  if (!SYMBOL_TYPES.has(p.typeId)) throw new OrError(`symbol stream holds type ${p.typeId}`);
  s.within(p.end, () => addOrVariant(symbols, r.symbolDef(p, true)));
}

function parsePage(b: Uint8Array, strings: string[], d: Dialect, warn: (w: string) => void): OrPage {
  const s = new Stream(b), r = new Reader(s, strings, d, warn);
  const p = r.prefixes(ST.PAGE);
  const page: OrPage = { name: '', pageSize: '', props: r.propsOf(p), settings: undefined as unknown as OrPageSettings, titleBlocks: [], wires: [], instances: [], ports: [], globals: [], offpage: [], busEntries: [], graphics: [], nets: new Map(), netGroups: [], blocks: [] };
  page.name = s.lzt();
  page.pageSize = s.lzt();
  page.settings = pageSettings(s);
  const list = (f: (rec: Record_) => void, trailer = 0) => { const n = s.u16(); for (let i = 0; i < n; i++) { f(r.structure()); if (trailer) s.skip(trailer); } };
  list((x) => { if (x.t === 'graphic') page.titleBlocks.push(x.v); });
  if (d.legacy) {
    let n = s.u16();
    for (let i = 0; i < n; i++) { s.u32(); s.lzt(); }
    n = s.u16();
    for (let i = 0; i < n; i++) { const g: OrNetGroup = { id: s.u32(), name: s.lzt(), members: [] }; const m = r.count(); for (let j = 0; j < m; j++) g.members.push(s.u32()); page.netGroups.push(g); }
  } else {
    const raw = (members: boolean) => { s.skip(9); const g: OrNetGroup = { id: s.u32(), name: s.lzt(), members: [] }; s.u32(); s.u32(); s.u32(); s.u32(); if (members) { const m = s.u16(); for (let j = 0; j < m; j++) g.members.push(s.u32()); } return g; };
    let n = s.u16();
    for (let i = 0; i < n; i++) page.netGroups.push(raw(false));
    n = s.u16();
    for (let i = 0; i < n; i++) page.netGroups.push(raw(true));
  }
  const nn = s.u16();
  for (let i = 0; i < nn; i++) { const name = s.lzt(), id = s.u32(); page.nets.set(id, name); }
  list((x) => { if (x.t === 'wire') page.wires.push(x.v); });
  list((x) => { if (x.t === 'placed') page.instances.push(x.v); else if (x.t === 'block') page.blocks.push(x.v); });
  list((x) => { if (x.t === 'graphic') page.ports.push(x.v); });
  list((x) => { if (x.t === 'graphic') page.globals.push(x.v); }, 5);
  list((x) => { if (x.t === 'graphic') page.offpage.push(x.v); }, 5);
  list(() => {});
  list((x) => { if (x.t === 'busentry') page.busEntries.push(x.v); });
  list((x) => { if (x.t === 'graphic') page.graphics.push(x.v); });
  if (p.end && s.pos > p.end) throw new OrError('page body beyond its stop');
  return page;
}

function parsePageOrder(b: Uint8Array, d: Dialect): string[] {
  const s = new Stream(b), r = new Reader(s, [], d);
  r.prefixes(d.legacy ? -1 : ST.SCH_LIB);
  s.lzt(); s.skip(4);
  const n = s.u16();
  const names: string[] = [];
  for (let i = 0; i < n; i++) names.push(s.lzt());
  return names.reverse();
}

function parseFolderOrder(b: Uint8Array): string[] {
  const s = new Stream(b);
  s.skip(4);
  const n = s.u16();
  const names: string[] = [];
  for (let i = 0; i < n; i++) { names.push(s.lzt()); if (s.u16() !== 9) throw new OrError('bad Views Directory record'); s.skip(20); }
  if (s.remaining) throw new OrError('Views Directory: trailing bytes');
  return names;
}

function occHeader(r: Reader, expected: number): Record<string, string> { const p = r.prefixes(expected, -1, 1); return r.propsOf(p); }
function occScope(r: Reader): OrScope {
  const s = r.s;
  return s.nested(() => {
    const scope: OrScope = { partRefs: new Map(), partUnitRefs: new Map(), partProps: new Map(), netNames: new Map(), blocks: [] };
    const nn = r.count();
    for (let i = 0; i < nn; i++) { occHeader(r, 0x43); const id = s.u32(); scope.netNames.set(id, s.lzt()); }
    const nt = r.count();
    for (let i = 0; i < nt; i++) { occHeader(r, 0x52); s.u32(); s.u32(); }
    if (!r.d.legacy) {
      const ng = s.u32();
      for (let i = 0; i < ng; i++) { occHeader(r, 0x5b); s.u32(); s.u32(); }
      if (s.matches(PREAMBLE)) { s.skip(4); s.skip(s.u32()); }
    }
    const no = r.count();
    for (let i = 0; i < no; i++) {
      const props = occHeader(r, 0x42);
      s.u32();
      const target = s.u32();
      if (!r.d.legacy) { s.expect(0x42, 'occurrence marker'); s.u32(); s.u32(); }
      const child = s.lzt(), ref = s.lzt();
      const unit = r.resolve(r.strIdx());
      const np = r.count();
      for (let k = 0; k < np; k++) { occHeader(r, -1); s.u32(); s.u16(); }
      const nested = occScope(r);
      if (child) scope.blocks.push({ targetDbId: target, childFolder: child, scope: nested });
      else {
        if (ref) scope.partRefs.set(target, ref);
        if (Object.keys(props).length) scope.partProps.set(target, props);
        if (unit) scope.partUnitRefs.set(target, unit);
      }
    }
    return scope;
  });
}
function parseOccurrences(b: Uint8Array, strings: string[], d: Dialect, warn: (w: string) => void): OrScope | undefined {
  const s = new Stream(b), r = new Reader(s, strings, d);
  const tree = () => { s.lzt(); s.skip(d.legacy ? 5 : 7); const np = r.count(); for (let i = 0; i < np; i++) { occHeader(r, 0x44); s.u32(); s.lzt(); } return occScope(r); };
  if (d.legacy) {
    try { const t = tree(); if (s.remaining) throw new OrError('trailing bytes'); return t; } catch (e) { warn(`The occurrence tree could not be read (${(e as Error).message}): designators from the pages`); return undefined; }
  }
  if (b.length < 9 || b[0] !== 0x42 || b[5] || b[6] || b[7] || b[8]) return undefined;
  try { s.u8(); s.u32(); s.u32(); return tree(); } catch (e) { warn(`The occurrence tree could not be read (${(e as Error).message}): designators from the pages`); return undefined; }
}

/* ── the compound file ── */

/** CFB names keep '/' and ':' as \x02 and \x03. */
const cfbName = (n: string) => n.replace(/\x02/g, '/').replace(/\x03/g, ':');
const kid = (e: CfbEntry | undefined, name: string, kind?: 'stream' | 'storage') => e?.children.find((c) => c.name.toLowerCase() === name.toLowerCase() && (!kind || c.kind === kind));
const kids = (e: CfbEntry | undefined, kind: 'stream' | 'storage') => (e?.children ?? []).filter((c) => c.kind === kind);

/** Long-framed (version 3) package stream: the first record's zero pad at bytes 7–10. */
function longFramedPackage(b: Uint8Array): boolean {
  if (b.length < 11) return false;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const len = dv.getUint32(3, true);
  return dv.getUint32(7, true) === 0 && len <= b.length - 11;
}

export function isOrcadFile(bytes: Uint8Array): boolean {
  try {
    const c = readCfb(bytes);
    const lib = kid(c.root, 'Library', 'stream');
    if (!lib) return false;
    const intro = cp1252.decode(lib.data.subarray(0, 32));
    return intro.startsWith('OrCAD Windows');
  } catch { return false; }
}

export function readOrcad(bytes: Uint8Array): OrDesign {
  const c = readCfb(bytes);
  const root = c.root;
  const warnings: string[] = [];
  const warn = (w: string) => { if (!warnings.includes(w) && warnings.length < 200) warnings.push(w); };
  const libE = kid(root, 'Library', 'stream');
  if (!libE) throw new OrError('no Library stream: not an OrCAD Capture file');
  const library = parseLibrary(libE.data);
  const isLibrary = !library.intro.startsWith('OrCAD Windows Design');
  const legacy = library.major < 3;
  const d: Dialect = { legacy, shortDisplay: library.major < 2 };
  const symbols = new Map<string, OrSymbol>(), packages = new Map<string, OrPackage>();
  const cache = kid(root, 'Cache', 'stream');
  if (cache) parseCache(cache.data, library.strings, { legacy, shortDisplay: false }, warn, symbols, packages);
  // Locally changed parts; a library's own packages and symbols
  for (const e of kids(kid(root, 'Packages', 'storage'), 'stream')) {
    const xs = new Map<string, OrSymbol>(), xp = new Map<string, OrPackage>();
    try { parsePackageStream(e.data, library.strings, { legacy: legacy || !longFramedPackage(e.data), shortDisplay: d.shortDisplay }, xs, xp); }
    catch (err) { warn(`Package ${cfbName(e.name)} could not be read: ${(err as Error).message}`); continue; }
    for (const [k, v] of xs) {
      const ex = symbols.get(k);
      if (!ex) symbols.set(k, v);
      else if (legacy) { if (ex.generalFlags < 0 && v.generalFlags >= 0) ex.generalFlags = v.generalFlags; }
      // A library's package streams are its symbols: they come first
      else if (isLibrary) { symbols.set(k, v); v.variants.push(ex, ...ex.variants); ex.variants = []; }
      else { if (ex.generalFlags < 0 && v.generalFlags >= 0) ex.generalFlags = v.generalFlags; const vs = v.variants; v.variants = []; ex.variants.push(v, ...vs); }
    }
    if (!legacy) for (const [k, v] of xp) { const ex = packages.get(k); if (!ex) packages.set(k, v); else if (isLibrary) { packages.set(k, v); v.variants.push(ex, ...ex.variants); ex.variants = []; } else { const vs = v.variants; v.variants = []; ex.variants.push(v, ...vs); } }
  }
  if (isLibrary) {
    for (const e of kids(kid(root, 'Symbols', 'storage'), 'stream')) {
      if (e.name.startsWith('$')) continue;
      try { parseSymbolStream(e.data, library.strings, d, symbols); } catch (err) { warn(`Symbol ${cfbName(e.name)} could not be read: ${(err as Error).message}`); }
    }
  }
  const design: OrDesign = { library, symbols, packages, folders: [], root: '', warnings, isLibrary };
  if (isLibrary) return design;

  // Schematic folders, in the order Capture lists them
  const views = kid(root, 'Views', 'storage');
  if (!views) throw new OrError('no Views storage: not an OrCAD Capture design');
  let folderEntries = kids(views, 'storage');
  const dir = kid(root, 'Views Directory', 'stream');
  if (dir) {
    try {
      const order = parseFolderOrder(dir.data).map(cfbName);
      const listed = order.map((n) => folderEntries.find((f) => cfbName(f.name) === n)).filter((x): x is CfbEntry => !!x);
      const rest = folderEntries.filter((f) => !listed.includes(f));
      folderEntries = [...listed, ...rest];
    } catch { folderEntries = [...folderEntries].sort((a, b) => a.name.localeCompare(b.name)); }
  }
  if (!folderEntries.length) throw new OrError('no schematic folders in it');
  for (const fe of folderEntries) {
    const pagesE = kid(fe, 'Pages', 'storage');
    const available = kids(pagesE, 'stream');
    let ordered: CfbEntry[] = [];
    const orderE = kid(fe, 'Schematic', 'stream');
    let known = false;
    if (orderE) {
      try {
        for (const n of parsePageOrder(orderE.data, d)) { const e = available.find((a) => cfbName(a.name) === n); if (e && !ordered.includes(e)) ordered.push(e); }
        known = true;
      } catch { ordered = []; }
    }
    if (known) for (const a of available) { if (!ordered.includes(a)) ordered.push(a); }
    else ordered = [...available].sort((a, b) => a.name.localeCompare(b.name));
    const pages: OrPage[] = [];
    for (const e of ordered) {
      try { pages.push(parsePage(e.data, library.strings, d, warn)); } catch (err) { warn(`Page ${cfbName(e.name)} could not be read and was left out: ${(err as Error).message}`); }
    }
    design.folders.push({ name: cfbName(fe.name), pages });
  }
  const want = library.schematicName.toLowerCase();
  design.root = design.folders.find((f) => f.name.toLowerCase() === want)?.name ?? design.folders[0]!.name;
  const rootE = folderEntries.find((f) => cfbName(f.name) === design.root);
  const hier = kid(kid(rootE, 'Hierarchy', 'storage'), 'Hierarchy', 'stream');
  if (hier) design.occurrences = parseOccurrences(hier.data, library.strings, d, warn);
  return design;
}
