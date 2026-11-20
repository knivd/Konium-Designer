/**
 * Raw DEFLATE (RFC 1951) decoded synchronously — for archives read while a document opens
 * (AD's multi-board documents are ZIPs of JSON), where the browser's DecompressionStream, being
 * asynchronous, can't be waited for.
 */

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Huff { counts: Uint16Array; symbols: Uint16Array }
function huff(lengths: ArrayLike<number>, n: number): Huff {
  const counts = new Uint16Array(16), offs = new Uint16Array(16), symbols = new Uint16Array(n);
  for (let i = 0; i < n; i++) counts[lengths[i]!]!++;
  counts[0] = 0;
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1]! + counts[i - 1]!;
  for (let i = 0; i < n; i++) if (lengths[i]) symbols[offs[lengths[i]!]!++] = i;
  return { counts, symbols };
}

/** What one entry may come to when unpacked: an archive that says or makes more is refused, not followed until memory runs out. */
export const MAX_INFLATED = 1 << 30;

export function inflateRawSync(src: Uint8Array, sizeHint = 0): Uint8Array {
  if (sizeHint > MAX_INFLATED) throw new Error('DEFLATE: more than this can unpack at once');
  let out = new Uint8Array(Math.max(1024, sizeHint || Math.min(src.length * 4, MAX_INFLATED)));
  let o = 0, pos = 0, bit = 0, buf = 0;
  const need = (n: number) => { if (o + n > MAX_INFLATED) throw new Error('DEFLATE: more than this can unpack at once'); if (o + n > out.length) { const b = new Uint8Array(Math.max(out.length * 2, o + n)); b.set(out.subarray(0, o)); out = b; } };
  const bits = (n: number): number => {
    while (bit < n) { if (pos >= src.length) throw new Error('DEFLATE: data ends early'); buf |= src[pos++]! << bit; bit += 8; }
    const v = buf & ((1 << n) - 1);
    buf >>>= n; bit -= n;
    return v;
  };
  const decode = (h: Huff): number => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const count = h.counts[len]!;
      if (code - count < first) return h.symbols[index + (code - first)]!;
      index += count; first += count; first <<= 1; code <<= 1;
    }
    throw new Error('DEFLATE: bad code');
  };
  let fixedL: Huff | null = null, fixedD: Huff | null = null;
  for (;;) {
    const last = bits(1), type = bits(2);
    if (type === 0) {
      buf = 0; bit = 0;
      const len = src[pos]! | (src[pos + 1]! << 8);
      pos += 4;
      need(len); out.set(src.subarray(pos, pos + len), o); o += len; pos += len;
    } else if (type === 1 || type === 2) {
      let L: Huff, D: Huff;
      if (type === 1) {
        if (!fixedL) {
          const l = new Uint8Array(288);
          l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
          fixedL = huff(l, 288); fixedD = huff(new Uint8Array(30).fill(5), 30);
        }
        L = fixedL; D = fixedD!;
      } else {
        const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
        const cl = new Uint8Array(19);
        for (let i = 0; i < ncode; i++) cl[ORDER[i]!] = bits(3);
        const ch = huff(cl, 19);
        const lens = new Uint8Array(nlen + ndist);
        for (let i = 0; i < nlen + ndist;) {
          const sym = decode(ch);
          if (sym < 16) lens[i++] = sym;
          else {
            let rep = 0, val = 0;
            if (sym === 16) { if (!i) throw new Error('DEFLATE: repeat with nothing before'); val = lens[i - 1]!; rep = 3 + bits(2); }
            else if (sym === 17) rep = 3 + bits(3);
            else rep = 11 + bits(7);
            while (rep--) lens[i++] = val;
          }
        }
        L = huff(lens.subarray(0, nlen), nlen); D = huff(lens.subarray(nlen), ndist);
      }
      for (;;) {
        const sym = decode(L);
        if (sym < 256) { need(1); out[o++] = sym; continue; }
        if (sym === 256) break;
        const li = sym - 257;
        const len = LBASE[li]! + bits(LEXT[li]!);
        const di = decode(D);
        const dist = DBASE[di]! + bits(DEXT[di]!);
        if (dist > o) throw new Error('DEFLATE: distance too far back');
        need(len);
        for (let k = 0; k < len; k++, o++) out[o] = out[o - dist]!;
      }
    } else throw new Error('DEFLATE: bad block type');
    if (last) break;
  }
  return out.slice(0, o);
}

/** A ZIP's entries read at once (stored and deflated), names as written (AD's use \). */
export function unzipSync(bytes: Uint8Array): { name: string; bytes: Uint8Array }[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a ZIP file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out: { name: string; bytes: Uint8Array }[] = [];
  const dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + csize);
    if (method === 0) out.push({ name, bytes: raw.slice() });
    else if (method === 8) out.push({ name, bytes: inflateRawSync(raw, usize) });
    else throw new Error(`${name}: ZIP method ${method}`);
  }
  return out;
}
