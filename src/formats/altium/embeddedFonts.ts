/**
 * EmbeddedFonts6: the TrueType fonts a board carries, so its strings look the same where the
 * fonts aren't installed (Preferences › PCB Editor › TrueType Fonts › Embed TrueType fonts inside
 * PCB documents). Header: the count (u32). Data, for each font: its full name, family and style
 * (each a u32 byte length and UTF-16LE text ending in a NUL), bold, italic and one more byte
 * (1 [est: compressed]), then a u32 length and the font file zlib-deflated.
 */
import { cfbPut, cfbStream, type CfbEntry } from '../cfb/cfb';
import { inflateRawSync } from '../inflate';

export interface EmbeddedFont { name: string; family: string; style: string; bold: boolean; italic: boolean; flag: number; zlib: Uint8Array }

export function readEmbeddedFonts(root: CfbEntry): EmbeddedFont[] {
  const d = cfbStream(root, 'EmbeddedFonts6/Data');
  if (!d?.length) return [];
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const out: EmbeddedFont[] = [];
  let o = 0;
  const str = () => { const n = v.getUint32(o, true); o += 4; const s = new TextDecoder('utf-16le').decode(d.subarray(o, o + n)).replace(/\0+$/, ''); o += n; return s; };
  try {
    while (o + 4 <= d.length) {
      const name = str(), family = str(), style = str();
      const bold = d[o]! !== 0, italic = d[o + 1]! !== 0, flag = d[o + 2]!;
      o += 3;
      const n = v.getUint32(o, true); o += 4;
      if (o + n > d.length) break;
      out.push({ name, family, style, bold, italic, flag, zlib: d.slice(o, o + n) });
      o += n;
    }
  } catch { /* a damaged tail: the fonts read so far */ }
  return out;
}

export function writeEmbeddedFonts(root: CfbEntry, fonts: EmbeddedFont[]): void {
  const parts: Uint8Array[] = [];
  const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
  const utf16 = (s: string) => { const t = `${s}\0`, b = new Uint8Array(t.length * 2); for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); b[i * 2] = c & 0xff; b[i * 2 + 1] = c >> 8; } return b; };
  for (const f of fonts) {
    for (const s of [f.name, f.family, f.style]) { const b = utf16(s); parts.push(u32(b.length), b); }
    parts.push(Uint8Array.of(f.bold ? 1 : 0, f.italic ? 1 : 0, f.flag), u32(f.zlib.length), f.zlib);
  }
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  cfbPut(root, 'EmbeddedFonts6/Data', all);
  cfbPut(root, 'EmbeddedFonts6/Header', u32(fonts.length));
}

/** The font file itself. */
export function fontFile(f: EmbeddedFont): Uint8Array { return inflateRawSync(f.zlib.subarray(2)); }

/** A font file zlib-deflated, as the board keeps it. */
export async function deflateFont(ttf: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([ttf as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
