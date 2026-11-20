/**
 * Reading spreadsheets for database links: an .xlsx's first (or named) worksheet as rows of
 * text — shared strings, inline strings, numbers and booleans; formulas give their cached
 * values. Also a ZIP reader (stored and deflated entries).
 */
import { charOf } from './codePoint';

export interface ZipEntry { name: string; data: () => Promise<Uint8Array> }

async function inflateRaw(b: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** The entries of a ZIP archive, by its central directory. */
export function unzipEntries(bytes: Uint8Array): ZipEntry[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a ZIP file');
  const out: ZipEntry[] = [];
  const dec = new TextDecoder();
  // (a damaged file's list of contents can point past its end: said as that, not as a DataView's error)
  try {
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + size);
    out.push({ name, data: async () => (method === 0 ? raw : method === 8 ? inflateRaw(raw) : Promise.reject(new Error(`ZIP method ${method}`))) });
  }
  } catch (e) { if (e instanceof RangeError) throw new Error('The file is damaged: its list of contents points past its end'); throw e; }
  return out;
}

export const xmlText = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => charOf(Number(n))).replace(/&amp;/g, '&');

/** Column letters → 0-based index. */
const colIndex = (ref: string) => { let n = 0; for (const c of ref.replace(/\d+/g, '')) n = n * 26 + (c.charCodeAt(0) - 64); return n - 1; };

/** A worksheet of an .xlsx as rows of strings (the first sheet, or the one named). */
export async function readXlsx(bytes: Uint8Array, sheet?: string): Promise<{ sheets: string[]; rows: string[][] }> {
  const entries = unzipEntries(bytes);
  const get = async (n: string) => { const e = entries.find((x) => x.name.toLowerCase() === n.toLowerCase()); return e ? new TextDecoder().decode(await e.data()) : null; };
  const shared: string[] = [];
  const ss = await get('xl/sharedStrings.xml');
  if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push([...m[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => xmlText(t[1]!)).join(''));
  const wb = (await get('xl/workbook.xml')) ?? '';
  const rels = (await get('xl/_rels/workbook.xml.rels')) ?? '';
  const sheets = [...wb.matchAll(/<sheet\b[^>]*name="([^"]*)"[^>]*r:id="([^"]*)"/g)].map((m) => ({ name: xmlText(m[1]!), rid: m[2]! }));
  const pick = (sheet ? sheets.find((s) => s.name.toLowerCase() === sheet.toLowerCase().replace(/\$$/, '')) : undefined) ?? sheets[0];
  let path = 'xl/worksheets/sheet1.xml';
  if (pick) {
    const t = new RegExp(`<Relationship\\b[^>]*Id="${pick.rid}"[^>]*Target="([^"]*)"`).exec(rels) ?? new RegExp(`<Relationship\\b[^>]*Target="([^"]*)"[^>]*Id="${pick.rid}"`).exec(rels);
    if (t) path = t[1]!.startsWith('/') ? t[1]!.slice(1) : `xl/${t[1]!}`;
  }
  const xml = (await get(path)) ?? '';
  const rows: string[][] = [];
  for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const c of r[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]!, body = c[2] ?? '';
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const type = /\bt="([^"]*)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let val = '';
      if (type === 's' && v !== undefined) val = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') val = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => xmlText(t[1]!)).join('');
      else if (type === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
      else if (v !== undefined) val = xmlText(v);
      const i = ref ? colIndex(ref) : row.length;
      while (row.length < i) row.push('');
      row[i] = val;
    }
    rows.push(row);
  }
  return { sheets: sheets.map((s) => s.name), rows };
}
