/**
 * Cadence Allegro binary boards (.brd, Allegro 16.0 to 19): the header, the string table and the
 * object blocks, read into a key-indexed database. Allegro writes its objects one after another,
 * each a type byte and a fixed layout whose fields vary with the release, so every block type is
 * read in full to find the next. The layouts follow KiCad's reading of the format
 * (pcbnew/pcb_io/allegro, itself reverse-engineered). Coordinates are mils times the header's
 * divisor, Y up.
 */

export class BrdError extends Error {}

/** Allegro releases, in order (the layouts change with them). */
export const V = { V160: 1, V161: 2, V162: 3, V164: 4, V165: 5, V166: 6, V172: 7, V174: 8, V175: 9, V180: 10, V181: 11, V190: 12 } as const;

export interface LayerInfo { cls: number; sub: number }
export interface PadComp { type: number; w: number; h: number; /** Rounded rectangles' corner radius, chamfered ones' chamfer (17.2 on). */ z1: number; offX: number; offY: number; shapePtr: number }
export interface Blk { t: number; key: number; next: number; off: number; [k: string]: unknown }

export interface BrdDb {
  ver: number;
  magic: number;
  versionString: string;
  units: number;
  divisor: number;
  header: { ll: Record<string, { head: number; tail: number }>; layerMap: { a: number; list: number }[]; maxKey: number; objectCount: number };
  strings: Map<number, string>;
  blocks: Map<number, Blk>;
  byType: Map<number, Blk[]>;
  warnings: string[];
}

class Rd {
  pos = 0;
  readonly dv: DataView;
  constructor(readonly b: Uint8Array) { this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  need(n: number) { if (this.pos + n > this.b.length) throw new BrdError(`read past the end at 0x${this.pos.toString(16)}`); }
  u8() { this.need(1); return this.b[this.pos++]!; }
  u16() { this.need(2); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  s16() { this.need(2); const v = this.dv.getInt16(this.pos, true); this.pos += 2; return v; }
  u32() { this.need(4); const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  s32() { this.need(4); const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; }
  skip(n: number) { this.need(n); this.pos += n; }
  arr(n: number) { const a: number[] = []; for (let i = 0; i < n; i++) a.push(this.u32()); return a; }
  sarr(n: number) { const a: number[] = []; for (let i = 0; i < n; i++) a.push(this.s32()); return a; }
  /** Allegro's doubles: two 32-bit words, high first. */
  dbl() { const a = this.u32(), b = this.u32(); const t = new DataView(new ArrayBuffer(8)); t.setUint32(0, a); t.setUint32(4, b); return t.getFloat64(0); }
  /** A fixed-size string, then on to the next 4-byte boundary. */
  fixed(n: number): string {
    this.need(n);
    let e = this.pos;
    while (e < this.pos + n && this.b[e] !== 0) e++;
    const s = latin1.decode(this.b.subarray(this.pos, e));
    this.pos += n;
    if (this.pos % 4) this.skip(4 - (this.pos % 4));
    return s;
  }
  /** A NUL-terminated string, then on to the next 4-byte boundary. */
  zstr(): string {
    let e = this.pos;
    while (e < this.b.length && this.b[e] !== 0) e++;
    if (e >= this.b.length) throw new BrdError(`unterminated string at 0x${this.pos.toString(16)}`);
    const s = latin1.decode(this.b.subarray(this.pos, e));
    this.pos = e + 1;
    if (this.pos % 4) this.skip(4 - (this.pos % 4));
    return s;
  }
  layer(): LayerInfo { const cls = this.u8(), sub = this.u8(); return { cls, sub }; }
}
const latin1 = new TextDecoder('windows-1252');

export function versionOf(magic: number): number {
  switch ((magic & 0xffffff00) >>> 0) {
    case 0x00130000: return V.V160;
    case 0x00130200: return V.V161;
    case 0x00130400: case 0x00130500: return V.V162;
    case 0x00130c00: return V.V164;
    case 0x00131000: return V.V165;
    case 0x00131500: return V.V166;
    case 0x00140400: case 0x00140500: case 0x00140600: case 0x00140700: return V.V172;
    case 0x00140900: case 0x00140e00: return V.V174;
    case 0x00141500: return V.V175;
    case 0x00150000: return V.V180;
    case 0x00150200: return V.V181;
    case 0x00160100: return V.V190;
    default: return 0;
  }
}

/** Whether these bytes look like an Allegro board (by its magic). */
export function isAllegroBrd(b: Uint8Array): boolean {
  if (b.length < 0x1200) return false;
  const magic = new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
  const major = (magic >>> 16) & 0xffff;
  return major >= 0x000f && major <= 0x0016 && (versionOf(magic) > 0 || major <= 0x0012);
}

const LL_NAMES = ['0x04', '0x06', '0x0C', 'shapes', '0x14', 'nets', '0x1C', '0x24_0x28', 'unknown1', '0x2B', '0x03_0x30', '0x0A', '0x1D', 'unknown2', '0x38', '0x2C', '0x0C_2', 'unknown3'];

function header(r: Rd, ver: number) {
  const ll: Record<string, { head: number; tail: number }> = {};
  const readLL = () => { const w1 = r.u32(), w2 = r.u32(); return ver >= V.V180 ? { head: w1, tail: w2 } : { head: w2, tail: w1 }; };
  r.u32(); // magic
  r.u32(); r.u32(); r.u32(); r.u32();
  const objectCount = r.u32();
  r.u32(); r.u32();
  let stringCount = 0, x27End = 0;
  if (ver < V.V180) r.arr(7);
  else { r.u32(); r.u32(); x27End = r.u32(); r.u32(); r.u32(); stringCount = r.u32(); r.u32(); for (let i = 1; i <= 5; i++) ll[`v18_${i}`] = readLL(); }
  for (const n of LL_NAMES) ll[n] = readLL();
  if (ver < V.V180) { r.u32(); r.u32(); }
  if (ver >= V.V180) ll.unknown5 = readLL();
  ll['0x36'] = readLL();
  if (ver < V.V180) ll.unknown5 = readLL();
  ll.unknown6 = readLL();
  ll['0x0A_2'] = readLL();
  if (ver < V.V180) r.u32();
  if (ver >= V.V180) { ll.v18_6 = readLL(); r.u32(); if (ver >= V.V181) r.arr(8); r.u32(); }
  const vs = r.b.subarray(r.pos, r.pos + 60);
  let e = 0;
  while (e < 60 && vs[e] !== 0) e++;
  const versionString = latin1.decode(vs.subarray(0, e)).trim();
  r.skip(60);
  r.u32();
  const maxKey = r.u32();
  r.arr(ver < V.V180 ? 17 : 9);
  const units = r.u8();
  r.skip(3);
  r.u32();
  if (ver < V.V180) { r.u32(); x27End = r.u32(); }
  r.u32();
  if (ver < V.V180) stringCount = r.u32();
  r.arr(50);
  r.u32(); r.u32(); r.u32();
  const divisor = r.u32();
  r.arr(ver >= V.V181 ? 102 : 110);
  const layerMap: { a: number; list: number }[] = [];
  for (let i = 0; i < 25; i++) layerMap.push({ a: r.u32(), list: r.u32() });
  return { ll, layerMap, maxKey, objectCount, units, divisor, stringCount, x27End, versionString };
}

/* ── the blocks ── */

function block(r: Rd, ver: number, x27End: number): Blk | null | 'end' {
  const off = r.pos;
  if (r.pos >= r.b.length) return 'end';
  const t = r.u8();
  const ge = (v: number) => ver >= v;
  const c = (v: number) => (ge(v) ? r.u32() : undefined);
  const b: Blk = { t, key: 0, next: 0, off };
  switch (t) {
    case 0x00: return 'end';
    case 0x01: {
      r.skip(1); b.unknownByte = r.u8(); b.subType = r.u8();
      b.key = r.u32(); b.next = r.u32(); b.parent = r.u32(); r.u32(); c(V.V172);
      b.width = r.u32(); b.sx = r.s32(); b.sy = r.s32(); b.ex = r.s32(); b.ey = r.s32();
      b.cx = r.dbl(); b.cy = r.dbl(); b.r = r.dbl(); b.bbox = r.sarr(4);
      return b;
    }
    case 0x03: {
      r.skip(1); b.code = r.u16(); b.key = r.u32(); b.next = r.u32(); c(V.V172);
      b.subType = r.u8(); r.u8(); const size = r.u16(); c(V.V172);
      switch (b.subType) {
        case 0x65: break;
        case 0x64: case 0x66: case 0x67: case 0x6a: b.value = r.u32(); break;
        case 0x69: b.value = [r.u32(), r.u32()]; break;
        case 0x68: case 0x6b: case 0x6d: case 0x6e: case 0x6f: case 0x71: case 0x73: case 0x78: b.value = r.fixed(size); break;
        case 0x6c: { const n = r.u32(); if (n > 1e6) throw new BrdError('0x03/0x6C count too large'); b.value = r.arr(n); break; }
        case 0x70: case 0x74: { const x0 = r.u16(), x1 = r.u16(); r.skip(x1 + 4 * x0); break; }
        case 0xf6: b.value = r.arr(20); break;
        default:
          if (size === 4) b.value = r.u32();
          else if (size === 8) b.value = [r.u32(), r.u32()];
          else throw new BrdError(`0x03 field: unknown subtype 0x${(b.subType as number).toString(16)} of ${size} bytes at 0x${off.toString(16)}`);
      }
      return b;
    }
    case 0x04: r.skip(1); r.u16(); b.key = r.u32(); b.next = r.u32(); b.net = r.u32(); b.connItem = r.u32(); c(V.V174); return b;
    case 0x05: {
      r.skip(1); b.layer = r.layer(); b.key = r.u32(); b.next = r.u32(); b.netAssignment = r.u32(); r.u32(); r.u32(); r.u32(); r.u32(); r.u32(); r.u32(); r.u32(); r.u32();
      c(V.V172); c(V.V172); b.firstSeg = r.u32(); r.u32(); r.u32();
      return b;
    }
    case 0x06: r.skip(3); b.key = r.u32(); b.next = r.u32(); b.deviceType = r.u32(); b.symbolName = r.u32(); b.firstInst = r.u32(); b.slot = r.u32(); b.pinNumber = r.u32(); b.fields = r.u32(); c(V.V172); return b;
    case 0x07: {
      r.skip(3); b.key = r.u32(); b.next = r.u32(); c(V.V172); c(V.V172); c(V.V172); b.fpInst = r.u32();
      if (!ge(V.V172)) r.u32();
      b.refDes = r.u32(); b.functionInst = r.u32(); b.x03 = r.u32(); r.u32(); b.firstPad = r.u32();
      return b;
    }
    case 0x08: {
      r.skip(1); r.u16(); b.key = r.u32(); if (ge(V.V172)) b.previous = r.u32(); else b.str = r.u32();
      b.next = r.u32(); if (ge(V.V172)) b.str = r.u32(); b.pinName = r.u32(); c(V.V172); b.ptr4 = r.u32();
      return b;
    }
    case 0x09: r.skip(3); b.key = r.u32(); r.arr(4); c(V.V172); r.arr(5); c(V.V174); return b;
    case 0x0a: r.skip(1); b.layer = r.layer(); b.key = r.u32(); b.next = r.u32(); r.u32(); c(V.V172); b.coords = r.sarr(4); r.arr(4); r.arr(5); c(V.V174); return b;
    case 0x0c: {
      r.skip(1); b.layer = r.layer(); b.key = r.u32(); b.next = r.u32(); r.u32(); r.u32();
      if (!ge(V.V172)) { b.shape = r.u8(); r.u8(); r.u16(); } else { b.shape = r.u32(); r.u32(); r.u32(); }
      r.u32(); c(V.V180); b.coords = r.sarr(2); b.size = r.sarr(2); b.group = r.u32(); r.u32(); r.u32();
      if (ge(V.V174) && !ge(V.V180)) r.u32();
      return b;
    }
    case 0x0d: {
      r.skip(3); b.key = r.u32(); b.name = r.u32(); b.next = r.u32(); c(V.V174); b.x = r.s32(); b.y = r.s32(); b.padstack = r.u32(); r.u32(); c(V.V172); b.flags = r.u32(); b.rotation = r.u32();
      return b;
    }
    case 0x0e: r.skip(1); b.layer = r.layer(); b.key = r.u32(); b.next = r.u32(); b.fp = r.u32(); r.u32(); r.u32(); r.u32(); c(V.V172); c(V.V172); b.coords = r.sarr(4); r.arr(3); b.rotation = r.u32(); return b;
    case 0x0f: {
      r.skip(3); b.key = r.u32(); b.slotName = r.u32(); c(V.V174);
      if (!ge(V.V190)) b.deviceType = r.fixed(32);
      c(V.V190); if (ge(V.V172)) b.next = r.u32(); b.ptr06 = r.u32(); b.ptr11 = r.u32(); r.u32();
      return b;
    }
    case 0x10: r.skip(3); b.key = r.u32(); c(V.V172); b.compInst = r.u32(); c(V.V174); r.u32(); r.u32(); b.functionName = r.u32(); b.slots = r.u32(); b.fields = r.u32(); return b;
    case 0x11: r.skip(1); r.u16(); b.key = r.u32(); b.pinName = r.u32(); b.next = r.u32(); b.pinNumber = r.u32(); r.u32(); c(V.V174); return b;
    case 0x12: r.skip(1); r.u16(); b.key = r.u32(); r.u32(); r.u32(); r.u32(); r.u32(); c(V.V165); c(V.V174); return b;
    case 0x14: r.skip(1); b.layer = r.layer(); b.key = r.u32(); b.next = r.u32(); b.parent = r.u32(); b.flags = r.u32(); c(V.V172); b.segment = r.u32(); b.ptr03 = r.u32(); b.ptr26 = r.u32(); return b;
    case 0x15: case 0x16: case 0x17:
      r.skip(3); b.key = r.u32(); b.next = r.u32(); b.parent = r.u32(); b.flags = r.u32(); c(V.V172); b.width = r.u32(); b.sx = r.s32(); b.sy = r.s32(); b.ex = r.s32(); b.ey = r.s32();
      return b;
    case 0x1a: r.skip(1); r.u16(); b.key = r.u32(); r.arr(20); return b;
    case 0x1b: r.skip(3); b.key = r.u32(); b.next = r.u32(); b.name = r.u32(); r.u32(); c(V.V172); b.type = r.u32(); b.assignment = r.u32(); b.ratline = r.u32(); b.fields = r.u32(); b.matchGroup = r.u32(); r.u32(); r.u32(); r.u32(); r.u32(); return b;
    case 0x1c: {
      r.pos = off + 1;
      r.u8(); const n = r.u8(); b.startLayer = r.u8(); b.key = r.u32(); b.next = r.u32(); b.name = r.u32();
      let layerCount = 0;
      if (!ge(V.V172)) {
        b.drill = r.u32(); r.u32(); r.u32(); r.u32(); r.u32(); r.u32(); r.u8(); b.flags = r.u8(); r.u8(); r.u8(); r.u16(); r.u16(); r.u16(); layerCount = r.u16();
        r.u32(); r.u32(); r.u32(); r.u32(); r.u32(); b.slotX = r.u32(); b.slotY = r.u32(); r.u32(); c(V.V165);
        b.plated = ((b.flags as number) & 0x01) !== 0;
      } else {
        r.u32(); r.u32(); r.u32();
        const tA = r.u8();
        b.padType = tA & 0xf0; r.u8(); b.flags = r.u8(); r.u8(); r.u32(); r.u32(); r.u16(); r.u16(); layerCount = r.u16(); r.u16();
        r.u32(); r.u32(); r.u32(); r.u32(); b.drill = r.u32(); r.u32(); r.u32(); b.slotX = r.u32(); b.slotY = r.u32(); r.u32(); r.u32(); r.u32(); r.u32(); r.u32(); r.u32();
        r.arr(21);
        if (ge(V.V180)) r.arr(8);
        b.plated = ((b.flags as number) & 0x20) !== 0;
      }
      if (layerCount > 256) throw new BrdError('padstack layer count too large');
      b.layerCount = layerCount;
      const fixed = !ge(V.V165) ? 10 : !ge(V.V172) ? 11 : 21;
      const per = !ge(V.V172) ? 3 : 4;
      const total = fixed + layerCount * per;
      const comps: PadComp[] = [];
      for (let i = 0; i < total; i++) {
        const type = r.u8(); r.u8(); r.u8(); r.u8(); c(V.V172);
        const w = r.s32(), h = r.s32();
        const z1 = ge(V.V172) ? r.s32() : 0;
        const offX = r.s32(), offY = r.s32();
        let shapePtr: number;
        if (ge(V.V172)) { r.u32(); shapePtr = r.u32(); } else { shapePtr = r.u32(); if (i < total - 1) r.u32(); }
        comps.push({ type, w, h, z1, offX, offY, shapePtr });
      }
      b.comps = comps; b.fixed = fixed; b.per = per;
      r.arr(n * (ge(V.V172) ? 10 : 8));
      return b;
    }
    case 0x1d: {
      r.skip(3); b.key = r.u32(); b.next = r.u32(); b.name = r.u32(); b.field = r.u32();
      const sa = r.u16(), sb = r.u16();
      const recB = ver === V.V161 ? 48 : 56;
      const dataB: Int32Array[] = [];
      for (let i = 0; i < sb; i++) { const a = new Int32Array(14); for (let k = 0; k < recB / 4; k++) a[k] = r.s32(); dataB.push(a); }
      r.skip(256 * sa);
      c(V.V172);
      b.dataB = dataB;
      return b;
    }
    case 0x1e: { r.skip(1); r.u16(); b.key = r.u32(); b.next = r.u32(); if (ge(V.V161)) { r.u16(); r.u16(); } r.u32(); const size = r.u32(); r.fixed(size); c(V.V172); return b; }
    case 0x1f: {
      r.skip(3); b.key = r.u32(); b.next = r.u32(); r.u32(); r.u32(); r.u32(); r.u16(); const size = r.u16();
      r.skip(ge(V.V175) ? size * 384 + 8 : ge(V.V172) ? size * 280 + 8 : ge(V.V162) ? size * 280 + 4 : size * 240 + 4);
      return b;
    }
    case 0x20: r.skip(1); r.u16(); b.key = r.u32(); b.next = r.u32(); r.arr(7); if (ge(V.V174)) r.arr(10); return b;
    case 0x21: { r.skip(1); r.u16(); const size = r.u32(); if (size < 12) throw new BrdError('0x21 block too small'); b.key = r.u32(); r.skip(size - 12); return b; }
    case 0x22: r.skip(1); r.u16(); b.key = r.u32(); c(V.V172); r.arr(8); return b;
    case 0x23: r.skip(1); b.layer = r.layer(); b.key = r.u32(); b.next = r.u32(); r.arr(2); r.u32(); r.u32(); r.u32(); r.sarr(5); r.arr(4); if (ge(V.V164)) r.arr(4); c(V.V174); return b;
    case 0x24: r.skip(1); b.layer = r.layer(); b.key = r.u32(); b.next = r.u32(); b.parent = r.u32(); r.u32(); c(V.V172); b.coords = r.sarr(4); r.u32(); r.u32(); r.u32(); b.rotation = r.u32(); return b;
    case 0x26: r.skip(1); r.u16(); b.key = r.u32(); b.member = r.u32(); c(V.V172); b.group = r.u32(); r.u32(); c(V.V174); return b;
    case 0x27: {
      if (x27End <= r.pos) throw new BrdError(`0x27 block past its end at 0x${r.pos.toString(16)}`);
      const total = x27End - 1 - (off + 1);
      r.pos = off + 1;
      r.skip(Math.min(total, x27End - 1 - r.pos));
      return b;
    }
    case 0x28: {
      r.skip(1); b.layer = r.layer(); b.key = r.u32(); b.next = r.u32(); b.ptr1 = r.u32(); r.u32(); b.unknown2 = c(V.V172) ?? 0; c(V.V172);
      b.ptr2 = r.u32(); b.ptr3 = r.u32(); b.firstKeepout = r.u32(); b.firstSeg = r.u32(); r.u32(); r.u32();
      const tp = c(V.V172); b.ptr6 = r.u32(); const tp16 = ge(V.V172) ? undefined : r.u32(); b.table = tp ?? tp16 ?? 0;
      b.coords = r.sarr(4);
      return b;
    }
    case 0x29: r.skip(1); r.u16(); b.key = r.u32(); r.u32(); r.u32(); r.u32(); r.u32(); b.x = r.s32(); b.y = r.s32(); b.padstack = r.u32(); r.u32(); r.u32(); r.u32(); r.u32(); r.u32(); return b;
    case 0x2a: {
      r.skip(1); const n = r.u16(); c(V.V174);
      const entries: { name: string | number; props: number }[] = [];
      if (!ge(V.V165)) for (let i = 0; i < n; i++) { const name = r.fixed(32); entries.push({ name, props: r.u32() }); }
      else for (let i = 0; i < n; i++) { const id = r.u32(), props = r.u32(); r.u32(); entries.push({ name: id, props }); }
      b.entries = entries; b.key = r.u32();
      return b;
    }
    case 0x2b: r.skip(3); b.key = r.u32(); b.name = r.u32(); r.u32(); b.coords = r.arr(4); b.next = r.u32(); b.firstInst = r.u32(); r.u32(); r.u32(); r.u32(); b.fields = r.u32(); r.u32(); r.u32(); r.u32(); c(V.V164); c(V.V172); return b;
    case 0x2c: { r.skip(1); b.subType = r.u16(); b.key = r.u32(); b.next = r.u32(); c(V.V172); c(V.V172); c(V.V172); b.str = r.u32(); if (!ge(V.V172)) r.u32(); b.ptr1 = r.u32(); b.ptr2 = r.u32(); b.ptr3 = r.u32(); b.flags = r.u32(); return b; }
    case 0x2d: {
      r.u8(); b.side = r.u8(); r.u8(); b.key = r.u32(); b.next = r.u32(); c(V.V172);
      if (!ge(V.V172)) b.instRef = r.u32();
      r.u16(); r.u16(); c(V.V172); b.flags = r.u32(); b.rotation = r.u32(); b.x = r.s32(); b.y = r.s32();
      if (ge(V.V172)) b.instRef = r.u32();
      b.graphic = r.u32(); b.firstPad = r.u32(); b.text = r.u32(); b.assembly = r.u32(); b.areas = r.u32(); r.u32(); r.u32();
      return b;
    }
    case 0x2e: r.skip(1); r.u16(); b.key = r.u32(); b.next = r.u32(); r.u32(); r.u32(); r.u32(); r.u32(); r.u32(); r.u32(); c(V.V172); return b;
    case 0x2f: r.skip(1); r.u16(); b.key = r.u32(); r.arr(6); return b;
    case 0x30: {
      r.skip(1); b.layer = r.layer(); b.key = r.u32(); b.next = r.u32();
      const props = () => ({ font: r.u8(), flags: r.u8(), align: r.u8(), reversal: r.u8() });
      if (ge(V.V172)) { r.u32(); r.u32(); b.font = props(); r.u32(); c(V.V174); }
      b.strGraphic = r.u32();
      if (ge(V.V172)) b.group = r.u32(); else { r.u32(); b.font = props(); }
      c(V.V172);
      b.x = r.s32(); b.y = r.s32(); r.u32(); b.rotation = r.u32();
      if (!ge(V.V172)) b.group = r.u32();
      return b;
    }
    case 0x31: {
      r.skip(1); b.strLayer = r.u16(); b.key = r.u32(); b.wrapper = r.u32(); b.x = r.s32(); b.y = r.s32(); r.u16(); const len = r.u16(); c(V.V174);
      b.value = r.fixed(len);
      return b;
    }
    case 0x32: {
      r.skip(1); b.layer = r.layer(); b.key = r.u32(); b.next = r.u32(); b.net = r.u32(); b.flags = r.u32(); c(V.V172);
      b.nextInFp = r.u32(); b.parentFp = r.u32(); r.u32(); b.pad = r.u32(); r.u32(); r.u32(); b.pinNumber = r.u32(); b.nextInComp = r.u32(); c(V.V172); b.nameText = r.u32(); r.u32(); b.coords = r.sarr(4);
      return b;
    }
    case 0x33: {
      r.skip(1); b.layer = r.layer(); b.key = r.u32(); b.next = r.u32(); b.net = r.u32(); r.u32(); c(V.V172); r.u32(); c(V.V172);
      b.x = r.s32(); b.y = r.s32(); r.u32(); b.padstack = r.u32(); r.u32(); r.u32(); r.u32(); r.u32(); r.sarr(4);
      return b;
    }
    case 0x34: r.skip(1); b.layer = r.layer(); b.key = r.u32(); b.next = r.u32(); b.ptr1 = r.u32(); c(V.V172); b.flags = r.u32(); b.firstSeg = r.u32(); r.u32(); r.u32(); return b;
    case 0x35: r.skip(3); r.skip(120); return b;
    case 0x36: {
      r.skip(1); const code = r.u16(); b.code = code; b.key = r.u32(); b.next = r.u32(); c(V.V172);
      const num = r.u32(), count = r.u32(); r.u32(); r.u32(); c(V.V174);
      if (num > 1e6 || count > num) throw new BrdError('0x36 block counts out of range');
      const fonts: { h: number; w: number; stroke: number }[] = [];
      for (let i = 0; i < num; i++) {
        switch (code) {
          case 0x02: r.fixed(32); r.arr(14); if (ge(V.V164)) r.arr(3); if (ge(V.V172)) r.arr(2); break;
          case 0x03: r.fixed(ge(V.V172) ? 64 : 32); c(V.V174); break;
          case 0x05: r.skip(28); c(V.V175); break;
          case 0x06: r.u16(); r.u8(); r.u8(); r.u32(); if (!ge(V.V172)) r.arr(50); break;
          case 0x08: {
            r.u32(); r.u32(); const h = r.u32(), w = r.u32(); if (ge(V.V174) && !ge(V.V190)) r.u32(); r.u32(); r.u32(); r.u32(); const stroke = r.u32(); if (ge(V.V172)) r.arr(8);
            if (i < count) fonts.push({ h, w, stroke });
            break;
          }
          case 0x0b: r.skip(1016); break;
          case 0x0c: r.skip(232); break;
          case 0x0d: r.skip(200); break;
          case 0x0f: r.u32(); r.arr(3); r.u32(); break;
          case 0x10: r.skip(108); if (ge(V.V180)) r.u32(); break;
          case 0x12: r.skip(1052); break;
          default: throw new BrdError(`0x36 block: unknown item type 0x${code.toString(16)}`);
        }
      }
      b.fonts = fonts;
      return b;
    }
    case 0x37: { r.skip(1); r.u16(); b.key = r.u32(); b.group = r.u32(); b.next = r.u32(); r.u32(); b.count = r.u32(); r.u32(); c(V.V174); b.ptrs = r.arr(100); return b; }
    case 0x38: r.skip(3); b.key = r.u32(); b.next = r.u32(); r.u32(); if (!ge(V.V166)) r.fixed(20); c(V.V166); c(V.V166); r.arr(7); c(V.V174); return b;
    case 0x39: r.skip(3); b.key = r.u32(); r.u32(); r.u32(); r.skip(44); return b;
    case 0x3a: r.skip(1); r.layer(); b.key = r.u32(); b.next = r.u32(); r.u32(); c(V.V174); return b;
    case 0x3b: { r.skip(1); r.u16(); const len = r.u32(); b.name = r.fixed(128); r.fixed(32); r.u32(); r.u32(); c(V.V172); b.value = r.fixed(len); return b; }
    case 0x3c: { r.skip(1); r.u16(); b.key = r.u32(); c(V.V174); const n = r.u32(); if (n > 1e6) throw new BrdError('0x3C count too large'); r.arr(n); return b; }
    case 0x3e: r.skip(3); b.key = r.u32(); r.arr(9); return b;
    default: return null;
  }
}

export function readBrd(bytes: Uint8Array): BrdDb {
  const r = new Rd(bytes);
  const magic = r.dv.getUint32(0, true);
  const ver = versionOf(magic);
  if (!ver) {
    const major = (magic >>> 16) & 0xffff;
    const vs = latin1.decode(bytes.subarray(0xf8, 0xf8 + 60)).replace(/\0.*$/s, '').trim();
    if (major <= 0x0012 || (magic >>> 24) >= 0x0f) throw new BrdError(`${vs || 'This file'} predates Allegro 16.0: open it in Allegro 16.0 or later and save it again (or export IPC-2581)`);
    throw new BrdError(`Unknown Allegro file version 0x${magic.toString(16)}`);
  }
  const h = header(r, ver);
  const strings = new Map<number, string>();
  r.pos = 0x1200;
  for (let i = 0; i < h.stringCount; i++) { const id = r.u32(); strings.set(id, r.zstr()); }
  const blocks = new Map<number, Blk>(), byType = new Map<number, Blk[]>();
  const warnings: string[] = [];
  for (;;) {
    if (r.pos % 4) r.pos += 4 - (r.pos % 4);
    const at = r.pos;
    const b = block(r, ver, h.x27End);
    if (b === 'end') {
      if (ver >= V.V180) {
        // Zero-padded gaps between groups of blocks
        let p = r.pos;
        while (p < bytes.length && bytes[p] === 0) p++;
        if (p < bytes.length && bytes[p]! > 0 && bytes[p]! <= 0x3e) {
          const start = p - (p % 4);
          if (bytes[start] && bytes[start]! <= 0x3e) { r.pos = start; continue; }
        }
      }
      break;
    }
    if (!b) { warnings.push(`Unknown Allegro object type 0x${bytes[at]!.toString(16)} at 0x${at.toString(16)}: the rest of the file left out`); break; }
    if (b.key) blocks.set(b.key, b);
    if (!byType.has(b.t)) byType.set(b.t, []);
    byType.get(b.t)!.push(b);
  }
  return { ver, magic, versionString: h.versionString, units: h.units, divisor: h.divisor || 1, header: { ll: h.ll, layerMap: h.layerMap, maxKey: h.maxKey, objectCount: h.objectCount }, strings, blocks, byType, warnings };
}
