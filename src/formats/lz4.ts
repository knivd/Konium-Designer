/**
 * LZ4 blocks (the raw block format: sequences of a token, literals, a 16-bit offset and a match
 * length) — read, and written with a greedy single-hash matcher (the format's end rules kept: the
 * last five bytes literals, no match starting in the last twelve).
 */

export function lz4Decode(src: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  let i = 0, o = 0;
  const n = src.length;
  while (i < n) {
    const tok = src[i++]!;
    let lit = tok >> 4;
    if (lit === 15) { let c: number; do { c = src[i++]!; lit += c; } while (c === 255); }
    out.set(src.subarray(i, i + lit), o); i += lit; o += lit;
    if (i >= n) break;
    const off = src[i]! | (src[i + 1]! << 8); i += 2;
    let ml = tok & 15;
    if (ml === 15) { let c: number; do { c = src[i++]!; ml += c; } while (c === 255); }
    ml += 4;
    let p = o - off;
    if (p < 0 || off === 0) throw new Error('LZ4: a match before the start');
    for (let k = 0; k < ml; k++) out[o++] = out[p++]!;
  }
  return o === size ? out : out.subarray(0, o);
}

export function lz4Encode(src: Uint8Array): Uint8Array {
  const n = src.length;
  const out = new Uint8Array(n + Math.ceil(n / 255) + 32);
  let op = 0;
  const BITS = 16;
  const table = new Int32Array(1 << BITS).fill(-1);
  const read32 = (i: number) => src[i]! | (src[i + 1]! << 8) | (src[i + 2]! << 16) | (src[i + 3]! << 24);
  const hash = (i: number) => Math.imul(read32(i), 2654435761) >>> (32 - BITS);
  const putLen = (len: number) => { while (len >= 255) { out[op++] = 255; len -= 255; } out[op++] = len; };
  const emit = (litStart: number, litLen: number, off: number, matchLen: number) => {
    const tokAt = op++;
    const ml = matchLen - 4;
    out[tokAt] = (Math.min(litLen, 15) << 4) | (matchLen ? Math.min(ml, 15) : 0);
    if (litLen >= 15) putLen(litLen - 15);
    out.set(src.subarray(litStart, litStart + litLen), op); op += litLen;
    if (!matchLen) return;
    out[op++] = off & 255; out[op++] = off >> 8;
    if (ml >= 15) putLen(ml - 15);
  };
  let anchor = 0, i = 0;
  const limit = n - 12, end = n - 5;
  while (i < limit) {
    const h = hash(i);
    const ref = table[h]!;
    table[h] = i;
    if (ref >= 0 && i - ref <= 65535 && read32(ref) === read32(i)) {
      let len = 4;
      while (i + len < end && src[ref + len] === src[i + len]) len++;
      emit(anchor, i - anchor, i - ref, len);
      i += len; anchor = i;
      continue;
    }
    i++;
  }
  emit(anchor, n - anchor, 0, 0);
  return out.slice(0, op);
}
