/**
 * Excel 97–2003 workbooks (.xls): the BIFF8 (and Excel 95's BIFF5) record stream inside the
 * compound file's Workbook stream, read as each worksheet's cells in rows of text — the shared
 * strings (split over CONTINUE records), labels, numbers (RK, MULRK, NUMBER), formula results,
 * booleans, and dates by their cell formats. What a database library reads from a workbook.
 */
import { cfbStream, readCfb } from '../cfb/cfb';
import { cp1252ToStr } from '../text';

export interface XlsSheet { name: string; rows: string[][] }

/** A number as Excel's General format shows it: whole numbers plainly, others to 15 figures. */
export function numText(n: number): string {
  if (!Number.isFinite(n)) return '';
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toPrecision(15)));
}

/** An Excel date serial (days from 1899-12-30, or 1904-01-01) as ISO text. */
export function excelDate(n: number, date1904 = false): string {
  const ms = Math.round((n + (date1904 ? 1462 : 0) - 25569) * 86400000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return numText(n);
  const iso = d.toISOString();
  const day = iso.slice(0, 10), time = iso.slice(11, 19);
  return n % 1 === 0 ? day : Math.floor(n) === 0 ? time : `${day} ${time}`;
}

/** Built-in number formats that show dates or times. */
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
/** A format string that shows a date or time: d, m, y, h or s outside quotes, brackets and escapes. */
export function isDateFormat(f: string): boolean {
  const bare = f.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/\[[^\]]*\]/g, '').replace(/_./g, '');
  return /[dmyhs]/i.test(bare) && !/^[#0.,%E+-]*$/i.test(bare);
}

class Reader {
  constructor(readonly b: Uint8Array, public pos = 0, readonly dv = new DataView(b.buffer, b.byteOffset, b.byteLength)) {}
  u8() { return this.b[this.pos++] ?? 0; }
  u16() { const v = this.pos + 2 <= this.b.length ? this.dv.getUint16(this.pos, true) : 0; this.pos += 2; return v; }
  u32() { const v = this.pos + 4 <= this.b.length ? this.dv.getUint32(this.pos, true) : 0; this.pos += 4; return v; }
  i32At(p: number) { return p + 4 <= this.b.length ? this.dv.getInt32(p, true) : 0; }
  u16At(p: number) { return p + 2 <= this.b.length ? this.dv.getUint16(p, true) : 0; }
  f64At(p: number) { return p + 8 <= this.b.length ? this.dv.getFloat64(p, true) : NaN; }
  chars(n: number, high: boolean): string {
    let s = '';
    if (high) { for (let i = 0; i < n; i++) s += String.fromCharCode(this.u16()); return s; }
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8());
    return s;
  }
}

/** An RK number: a 30-bit integer or the top of a double, maybe in hundredths. */
export function rk(v: number): number {
  let n: number;
  if (v & 2) n = v >> 2;
  else { const dv = new DataView(new ArrayBuffer(8)); dv.setUint32(4, v & 0xfffffffc, true); n = dv.getFloat64(0, true); }
  return v & 1 ? n / 100 : n;
}

interface Rec { type: number; data: Uint8Array }

function records(b: Uint8Array, from: number, to = b.length): Rec[] {
  const out: Rec[] = [];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = from;
  while (p + 4 <= to) {
    const type = dv.getUint16(p, true), len = dv.getUint16(p + 2, true);
    out.push({ type, data: b.subarray(p + 4, Math.min(to, p + 4 + len)) });
    p += 4 + len;
    if (type === 0x000a) break; // EOF
  }
  return out;
}

/** The shared string table: strings whose characters may run on into CONTINUE records, each such part led by its own high-byte flag. */
function sharedStrings(parts: Uint8Array[]): string[] {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const all = new Uint8Array(total);
  const bounds: number[] = [];
  let at = 0;
  for (const p of parts) { if (at) bounds.push(at); all.set(p, at); at += p.length; }
  const r = new Reader(all);
  r.u32(); // total references
  const n = r.u32();
  const out: string[] = [];
  const nextBound = (p: number) => bounds.find((x) => x >= p) ?? total;
  for (let k = 0; k < n && r.pos < total; k++) {
    let left = r.u16();
    const flags = r.u8();
    let high = (flags & 1) !== 0;
    const runs = flags & 8 ? r.u16() : 0;
    const ext = flags & 4 ? r.u32() : 0;
    let s = '';
    while (left > 0 && r.pos < total) {
      const end = nextBound(r.pos);
      const avail = high ? (end - r.pos) >> 1 : end - r.pos;
      const take = Math.min(left, avail);
      s += r.chars(take, high);
      left -= take;
      if (left > 0) high = (r.u8() & 1) !== 0; // the next part's flag
    }
    r.pos += runs * 4 + ext;
    out.push(s);
  }
  return out;
}

export function isXls(b: Uint8Array): boolean {
  try { const f = readCfb(b); return !!(cfbStream(f.root, 'Workbook') ?? cfbStream(f.root, 'Book')); } catch { return false; }
}

/** The workbook's worksheets, each as rows of cell text (empty cells ''). */
export function readXls(bytes: Uint8Array): XlsSheet[] {
  const f = readCfb(bytes);
  const wb = cfbStream(f.root, 'Workbook') ?? cfbStream(f.root, 'Book');
  if (!wb) throw new Error('not an Excel workbook (no Workbook stream)');
  const globals = records(wb, 0);
  const bof = globals[0];
  if (!bof || (bof.type & 0xff) !== 0x09) throw new Error('not an Excel workbook (no BOF record)');
  const biff8 = new Reader(bof.data).u16() === 0x0600;
  if (globals.some((r) => r.type === 0x002f)) throw new Error('the workbook is password-protected (encrypted): save it without a password');
  const decode8 = (s: string) => cp1252ToStr(s);
  // An XLUnicodeString (BIFF8) or a byte string (BIFF5) with a 16- or 8-bit length
  const str = (r: Reader, wide: boolean): string => {
    const n = wide ? r.u16() : r.u8();
    if (!biff8) return decode8(r.chars(n, false));
    const fl = r.u8();
    return r.chars(n, (fl & 1) !== 0);
  };
  const sheets: { name: string; pos: number }[] = [];
  const formats = new Map<number, string>();
  const xfFormat: number[] = [];
  let sst: string[] = [];
  let date1904 = false;
  for (let i = 0; i < globals.length; i++) {
    const rec = globals[i]!, r = new Reader(rec.data);
    if (rec.type === 0x0085) { // BOUNDSHEET
      const pos = r.u32(); r.u8(); const kind = r.u8();
      const name = str(r, false);
      if (kind === 0) sheets.push({ name, pos });
    } else if (rec.type === 0x00fc) { // SST and its CONTINUEs
      const parts = [rec.data];
      while (globals[i + 1]?.type === 0x003c) parts.push(globals[++i]!.data);
      sst = sharedStrings(parts);
    } else if (rec.type === 0x041e || rec.type === 0x001e) { // FORMAT
      const id = r.u16();
      formats.set(id, str(r, biff8));
    } else if (rec.type === 0x00e0) { // XF
      r.u16(); xfFormat.push(r.u16());
    } else if (rec.type === 0x0022) date1904 = r.u16() === 1;
  }
  const isDate = (xf: number) => {
    const fmt = xfFormat[xf];
    if (fmt === undefined) return false;
    if (DATE_FORMATS.has(fmt)) return true;
    const s = formats.get(fmt);
    return s !== undefined && isDateFormat(s);
  };
  const num = (n: number, xf: number) => (isDate(xf) ? excelDate(n, date1904) : numText(n));
  return sheets.map(({ name, pos }) => {
    const rows: string[][] = [];
    const put = (row: number, col: number, v: string) => {
      while (rows.length <= row) rows.push([]);
      const line = rows[row]!;
      while (line.length < col) line.push('');
      line[col] = v;
    };
    let pending: [number, number] | null = null;
    for (const rec of records(wb, pos)) {
      const r = new Reader(rec.data);
      switch (rec.type) {
        case 0x00fd: { const row = r.u16(), col = r.u16(); r.u16(); put(row, col, sst[r.u32()] ?? ''); break; } // LABELSST
        case 0x0204: case 0x00d6: { const row = r.u16(), col = r.u16(); r.u16(); put(row, col, str(r, true)); break; } // LABEL, RSTRING
        case 0x0203: { const row = r.u16(), col = r.u16(), xf = r.u16(); put(row, col, num(r.f64At(6), xf)); break; } // NUMBER
        case 0x027e: { const row = r.u16(), col = r.u16(), xf = r.u16(); put(row, col, num(rk(r.u32()), xf)); break; } // RK
        case 0x00bd: { // MULRK
          const row = r.u16(); let col = r.u16();
          while (r.pos + 6 <= rec.data.length - 2) { const xf = r.u16(); put(row, col++, num(rk(r.u32()), xf)); }
          break;
        }
        case 0x0205: { const row = r.u16(), col = r.u16(); r.u16(); const v = r.u8(), err = r.u8(); put(row, col, err ? '' : v ? 'TRUE' : 'FALSE'); break; } // BOOLERR
        case 0x0006: { // FORMULA: its cached result
          const row = r.u16(), col = r.u16(), xf = r.u16();
          if (r.u16At(12) === 0xffff) {
            const t = rec.data[6];
            if (t === 0) pending = [row, col];
            else if (t === 1) put(row, col, rec.data[8] ? 'TRUE' : 'FALSE');
          } else put(row, col, num(r.f64At(6), xf));
          break;
        }
        case 0x0207: if (pending) { put(pending[0], pending[1], str(r, true)); pending = null; } break; // STRING
        default: break;
      }
    }
    return { name, rows };
  });
}
