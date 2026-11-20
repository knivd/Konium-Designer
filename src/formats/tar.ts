/**
 * A ustar archive (ODB++ jobs travel as .tgz): directories and files in order, then gzipped
 * with the browser's CompressionStream.
 */
const enc = new TextEncoder();

function header(name: string, size: number, dir: boolean, mtime: number): Uint8Array {
  const h = new Uint8Array(512);
  const put = (off: number, len: number, s: string) => { const b = enc.encode(s); h.set(b.subarray(0, len), off); };
  const oct = (off: number, len: number, v: number) => put(off, len, v.toString(8).padStart(len - 1, '0') + '\0');
  // Names past 100 bytes go in the prefix field (split at a slash)
  let n = name, prefix = '';
  if (enc.encode(n).length > 100) {
    const cut = n.lastIndexOf('/', 154);
    prefix = n.slice(0, cut); n = n.slice(cut + 1);
  }
  put(0, 100, n);
  oct(100, 8, dir ? 0o755 : 0o644);
  oct(108, 8, 0); oct(116, 8, 0);
  oct(124, 12, size);
  oct(136, 12, Math.floor(mtime / 1000));
  h.fill(0x20, 148, 156); // checksum counted as spaces
  h[156] = dir ? 0x35 : 0x30;
  put(257, 6, 'ustar\0'); put(263, 2, '00');
  put(345, 155, prefix);
  let sum = 0;
  for (const b of h) sum += b;
  put(148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
  return h;
}

/** Files (paths with forward slashes; their folders are added) as one tar archive. */
export function tar(files: { name: string; bytes: Uint8Array }[], when = new Date()): Uint8Array {
  const parts: Uint8Array[] = [];
  const dirs = new Set<string>();
  const t = when.getTime();
  for (const f of files) {
    const segs = f.name.split('/');
    for (let i = 1; i < segs.length; i++) {
      const d = segs.slice(0, i).join('/') + '/';
      if (!dirs.has(d)) { dirs.add(d); parts.push(header(d, 0, true, t)); }
    }
    parts.push(header(f.name, f.bytes.length, false, t), f.bytes);
    const pad = (512 - (f.bytes.length % 512)) % 512;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** gzip (CompressionStream: browsers and Node 18+). */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
