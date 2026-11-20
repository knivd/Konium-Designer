/** Little-endian binary reader over a byte window [pos, end). */
export class BinReader {
  pos: number;
  readonly end: number;
  private dv: DataView;

  constructor(readonly buf: Uint8Array, pos = 0, end = buf.length) {
    this.pos = pos;
    this.end = end;
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get remaining(): number { return this.end - this.pos; }
  get eof(): boolean { return this.pos >= this.end; }

  need(n: number): void {
    if (n < 0 || this.pos + n > this.end) {
      throw new RangeError(`read of ${n} bytes at ${this.pos} overruns window ending ${this.end}`);
    }
  }
  skip(n: number): this { this.need(n); this.pos += n; return this; }
  u8(): number { this.need(1); return this.buf[this.pos++]!; }
  u16(): number { this.need(2); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  i16(): number { this.need(2); const v = this.dv.getInt16(this.pos, true); this.pos += 2; return v; }
  u32(): number { this.need(4); const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  i32(): number { this.need(4); const v = this.dv.getInt32(this.pos, true); this.pos += 4; return v; }
  f64(): number { this.need(8); const v = this.dv.getFloat64(this.pos, true); this.pos += 8; return v; }
  bytes(n: number): Uint8Array { this.need(n); const v = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return v; }
  /** Sub-reader over the next n bytes; advances this reader past them. */
  window(n: number): BinReader { this.need(n); const r = new BinReader(this.buf, this.pos, this.pos + n); this.pos += n; return r; }
}

/** Growable little-endian writer. */
export class BinWriter {
  private buf: Uint8Array;
  private dv: DataView;
  length = 0;

  constructor(initial = 1024) {
    this.buf = new Uint8Array(initial);
    this.dv = new DataView(this.buf.buffer);
  }

  private ensure(n: number): void {
    if (this.length + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.length + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.length));
    this.buf = nb;
    this.dv = new DataView(nb.buffer);
  }

  u8(v: number): this { this.ensure(1); this.buf[this.length++] = v & 0xff; return this; }
  u16(v: number): this { this.ensure(2); this.dv.setUint16(this.length, v, true); this.length += 2; return this; }
  i16(v: number): this { this.ensure(2); this.dv.setInt16(this.length, v, true); this.length += 2; return this; }
  u32(v: number): this { this.ensure(4); this.dv.setUint32(this.length, v >>> 0, true); this.length += 4; return this; }
  i32(v: number): this { this.ensure(4); this.dv.setInt32(this.length, v, true); this.length += 4; return this; }
  f64(v: number): this { this.ensure(8); this.dv.setFloat64(this.length, v, true); this.length += 8; return this; }
  zeros(n: number): this { this.ensure(n); this.buf.fill(0, this.length, this.length + n); this.length += n; return this; }
  bytes(b: Uint8Array): this { this.ensure(b.length); this.buf.set(b, this.length); this.length += b.length; return this; }
  /** Overwrite a u32 at an absolute offset (for back-patching lengths). */
  patchU32(at: number, v: number): this { this.dv.setUint32(at, v >>> 0, true); return this; }

  finish(): Uint8Array { return this.buf.slice(0, this.length); }
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function hexDump(b: Uint8Array, max = 512, base = 0): string {
  const lines: string[] = [];
  const n = Math.min(b.length, max);
  for (let o = 0; o < n; o += 16) {
    const row = b.subarray(o, Math.min(o + 16, n));
    const hex = [...row].map((x) => x.toString(16).padStart(2, '0')).join(' ').padEnd(47);
    const asc = [...row].map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '·')).join('');
    lines.push(`${(base + o).toString(16).padStart(6, '0')}  ${hex}  ${asc}`);
  }
  if (b.length > max) lines.push(`… ${b.length - max} more bytes`);
  return lines.join('\n');
}
