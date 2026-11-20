/**
 * Microsoft Access databases (.mdb, .accdb): the Jet 3 (Access 97), Jet 4 (2000–2003) and ACE
 * (2007 and later) page files read without the Access engine — the catalogue (MSysObjects), each
 * user table's definition and its rows from the data pages its usage map names, with memo
 * (long value) chains, Jet 4's compressed Unicode, numbers, dates and GUIDs as text. Read only;
 * a password-encrypted or encoded database is refused. [est: layouts after mdbtools and Jackcess]
 */
import { cp1252ToStr } from '../text';
import { excelDate, numText } from './xls';

export interface JetTable { name: string; columns: string[]; rows: Record<string, string>[] }

interface Fmt {
  pg: number; jet3: boolean;
  dataRowCount: number;
  tabNumRows: number; numVarCols: number; numCols: number; numIdx: number; numRIdx: number; usageMap: number; colsStart: number;
  ridxEntry: number; colEntry: number; colNum: number; offV: number; colFlags: number; offF: number; colSize: number; colScale: number; colPrec: number;
}
const JET3: Fmt = { pg: 2048, jet3: true, dataRowCount: 8, tabNumRows: 12, numVarCols: 23, numCols: 25, numIdx: 27, numRIdx: 31, usageMap: 35, colsStart: 43, ridxEntry: 8, colEntry: 18, colNum: 1, offV: 3, colFlags: 13, offF: 14, colSize: 16, colScale: 9, colPrec: 10 };
const JET4: Fmt = { pg: 4096, jet3: false, dataRowCount: 12, tabNumRows: 16, numVarCols: 43, numCols: 45, numIdx: 47, numRIdx: 51, usageMap: 55, colsStart: 63, ridxEntry: 12, colEntry: 25, colNum: 5, offV: 7, colFlags: 15, offF: 21, colSize: 23, colScale: 11, colPrec: 12 };

interface Col { name: string; type: number; num: number; varNum: number; fixed: boolean; fixedOff: number; size: number; scale: number; prec: number }

export function isJet(b: Uint8Array): boolean {
  if (b.length < 0x18 || b[0] !== 0 || b[1] !== 1 || b[2] !== 0 || b[3] !== 0) return false;
  const sig = String.fromCharCode(...b.subarray(4, 19));
  return sig === 'Standard Jet DB' || sig === 'Standard ACE DB';
}

class Db {
  readonly f: Fmt;
  readonly dv: DataView;
  readonly pages: number;
  constructor(readonly b: Uint8Array) {
    if (!isJet(b)) throw new Error('not an Access database');
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const ver = this.dv.getUint32(0x14, true);
    this.f = ver === 0 ? JET3 : JET4;
    this.pages = Math.floor(b.length / this.f.pg);
  }
  u8(p: number) { return this.b[p] ?? 0; }
  u16(p: number) { return p + 2 <= this.b.length ? this.dv.getUint16(p, true) : 0; }
  u24(p: number) { return this.u16(p) | (this.u8(p + 2) << 16); }
  u32(p: number) { return p + 4 <= this.b.length ? this.dv.getUint32(p, true) : 0; }
  page(n: number): number {
    if (n <= 0 || n >= this.pages) throw new Error(`page ${n} is outside the file`);
    return n * this.f.pg;
  }
  /** Row r of data page n: its bytes' start and end (exclusive) and flags. */
  row(n: number, r: number): { start: number; end: number; deleted: boolean; overflow: boolean } | null {
    const base = this.page(n), rc = base + this.f.dataRowCount;
    if (this.u8(base) !== 0x01) return null;
    const count = this.u16(rc);
    if (r >= count) return null;
    const off = this.u16(rc + 2 + 2 * r);
    const next = r === 0 ? this.f.pg : this.u16(rc + 2 * r) & 0x1fff;
    const start = off & 0x1fff;
    if (start >= next) return null;
    return { start: base + start, end: base + next, deleted: (off & 0x8000) !== 0, overflow: (off & 0x4000) !== 0 };
  }
  /** A table definition, continued over its chain of pages. */
  tdef(n: number): Uint8Array {
    const parts: Uint8Array[] = [];
    let p = n, first = true, guard = 0;
    while (p && guard++ < 1000) {
      const at = this.page(p);
      if (this.u8(at) !== 0x02) throw new Error(first ? 'the database is encrypted or encoded (its table definitions can\'t be read): save a copy without a password' : 'a broken table definition');
      parts.push(this.b.subarray(first ? at : at + 8, at + this.f.pg));
      p = this.u32(at + 4);
      first = false;
    }
    const out = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
    let o = 0;
    for (const x of parts) { out.set(x, o); o += x.length; }
    return out;
  }
  /** Text: Jet 4's UCS-2 (compressed when it starts FF FE: runs of single bytes and pairs, switched by a 0 byte), Jet 3's code page. */
  text(p: number, len: number): string { return this.textOf(this.b.subarray(p, p + len)); }
  textOf(raw: Uint8Array): string {
    let s = '';
    if (this.f.jet3) { for (const x of raw) s += String.fromCharCode(x); return cp1252ToStr(s); }
    if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
      let compressed = true;
      for (let i = 2; i < raw.length;) {
        if (raw[i] === 0) { compressed = !compressed; i++; }
        else if (compressed) s += String.fromCharCode(raw[i++]!);
        else if (i + 1 < raw.length) { s += String.fromCharCode(raw[i]! | (raw[i + 1]! << 8)); i += 2; } else break;
      }
      return s;
    }
    for (let i = 0; i + 1 < raw.length; i += 2) s += String.fromCharCode(raw[i]! | (raw[i + 1]! << 8));
    return s;
  }
  /** A memo or OLE value: inline, on one long-value row, or a chain of them. */
  longValue(p: number, size: number): Uint8Array {
    if (size < 12) return new Uint8Array(0);
    const head = this.u32(p), len = head & 0x3fffffff;
    if (head & 0x80000000) return this.b.subarray(p + 12, p + 12 + Math.min(len, size - 12));
    const ptrRow = this.u8(p + 4), ptrPage = this.u24(p + 5);
    if (head & 0x40000000) {
      const r = this.row(ptrPage, ptrRow);
      return r ? this.b.subarray(r.start, Math.min(r.end, r.start + len)) : new Uint8Array(0);
    }
    const out = new Uint8Array(len);
    let o = 0, row = ptrRow, page = ptrPage, guard = 0;
    while (page && o < len && guard++ < 100000) {
      const r = this.row(page, row);
      if (!r || r.end - r.start < 4) break;
      const nextRow = this.u8(r.start), nextPage = this.u24(r.start + 1);
      const chunk = this.b.subarray(r.start + 4, Math.min(r.end, r.start + 4 + (len - o)));
      out.set(chunk, o); o += chunk.length;
      row = nextRow; page = nextPage;
    }
    return out.subarray(0, o);
  }
}

function columnsOf(db: Db, t: Uint8Array): { cols: Col[]; usage: [number, number] } {
  const f = db.f;
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const u16 = (p: number) => (p + 2 <= t.length ? dv.getUint16(p, true) : 0);
  const numCols = u16(f.numCols), numRIdx = p32(dv, t, f.numRIdx);
  const usageRow = t[f.usageMap] ?? 0, usagePage = (t[f.usageMap + 1] ?? 0) | ((t[f.usageMap + 2] ?? 0) << 8) | ((t[f.usageMap + 3] ?? 0) << 16);
  let p = f.colsStart + numRIdx * f.ridxEntry;
  const cols: Col[] = [];
  for (let i = 0; i < numCols; i++, p += f.colEntry) {
    cols.push({
      name: '', type: t[p] ?? 0, num: f.jet3 ? (t[p + f.colNum] ?? 0) : u16(p + f.colNum), varNum: u16(p + f.offV),
      fixed: ((t[p + f.colFlags] ?? 0) & 1) !== 0, fixedOff: u16(p + f.offF), size: u16(p + f.colSize),
      scale: t[p + f.colScale] ?? 0, prec: t[p + f.colPrec] ?? 0,
    });
  }
  for (const c of cols) {
    if (f.jet3) { const n = t[p] ?? 0; let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(t[p + 1 + i] ?? 0); c.name = cp1252ToStr(s); p += 1 + n; }
    else {
      const n = u16(p);
      c.name = db.textOf(t.subarray(p + 2, p + 2 + n)); p += 2 + n;
    }
  }
  cols.sort((a, b) => a.num - b.num);
  return { cols, usage: [usageRow, usagePage] };
}
const p32 = (dv: DataView, t: Uint8Array, p: number) => (p + 4 <= t.length ? dv.getUint32(p, true) : 0);

/** The data pages a usage map names: a bitmap from a start page, or pages of bitmaps. */
function usagePages(db: Db, row: number, page: number, tdefPage: number): number[] {
  const r = page ? db.row(page, row) : null;
  const out: number[] = [];
  if (r && r.end > r.start) {
    const kind = db.u8(r.start);
    if (kind === 0) {
      const first = db.u32(r.start + 1);
      for (let i = r.start + 5, k = 0; i < r.end; i++, k += 8) { const byte = db.u8(i); for (let bit = 0; bit < 8; bit++) if (byte & (1 << bit)) out.push(first + k + bit); }
    } else if (kind === 1) {
      const per = (db.f.pg - 4) * 8;
      for (let i = r.start + 1, m = 0; i + 4 <= r.end; i += 4, m++) {
        const mp = db.u32(i);
        if (!mp || mp >= db.pages) continue;
        const at = mp * db.f.pg;
        for (let j = 4; j < db.f.pg; j++) { const byte = db.u8(at + j); if (byte) for (let bit = 0; bit < 8; bit++) if (byte & (1 << bit)) out.push(m * per + (j - 4) * 8 + bit); }
      }
    }
  }
  // Only the table's own data pages (a map can't be read: every page that says it is the table's)
  const own = out.filter((n) => n > 0 && n < db.pages && db.u8(n * db.f.pg) === 0x01 && db.u32(n * db.f.pg + 4) === tdefPage);
  if (own.length || r) return own;
  const all: number[] = [];
  for (let n = 1; n < db.pages; n++) if (db.u8(n * db.f.pg) === 0x01 && db.u32(n * db.f.pg + 4) === tdefPage) all.push(n);
  return all;
}

function value(db: Db, c: Col, p: number, size: number, present: boolean): string {
  const dv = db.dv;
  switch (c.type) {
    case 1: return present ? 'True' : 'False';
    case 2: return String(db.u8(p));
    case 3: return String(dv.getInt16(p, true));
    case 4: return String(dv.getInt32(p, true));
    case 5: return numText(Number(dv.getBigInt64(p, true)) / 10000);
    case 6: return numText(Number(dv.getFloat32(p, true).toPrecision(7)));
    case 7: return numText(dv.getFloat64(p, true));
    case 8: return excelDate(dv.getFloat64(p, true));
    case 10: return db.text(p, size);
    case 12: return db.textOf(db.longValue(p, size));
    case 15: {
      const h = (a: number, n: number) => [...db.b.subarray(a, a + n)].map((x) => x.toString(16).padStart(2, '0')).join('');
      const rev = (a: number, n: number) => [...db.b.subarray(a, a + n)].reverse().map((x) => x.toString(16).padStart(2, '0')).join('');
      return `{${rev(p, 4)}-${rev(p + 4, 2)}-${rev(p + 6, 2)}-${h(p + 8, 2)}-${h(p + 10, 6)}}`.toUpperCase();
    }
    case 16: {
      // Sign, then four 32-bit words, the most significant first
      let n = 0n;
      for (let k = 0; k < 4; k++) n = (n << 32n) | BigInt(db.u32(p + 1 + 4 * k));
      let s = n.toString();
      if (c.scale > 0) { s = s.padStart(c.scale + 1, '0'); s = `${s.slice(0, -c.scale)}.${s.slice(-c.scale)}`.replace(/\.?0+$/, ''); }
      return (db.u8(p) & 0x80 ? '-' : '') + s;
    }
    case 20: return dv.getBigInt64(p, true).toString();
    default: return '';
  }
}

/** One row's values by column. */
function crack(db: Db, cols: Col[], numVar: number, start: number, end: number): Record<string, string> {
  const f = db.f;
  const last = end - 1;
  const rowCols = f.jet3 ? db.u8(start) : db.u16(start);
  const countSize = f.jet3 ? 1 : 2;
  const mask = Math.floor((rowCols + 7) / 8);
  const nulls = last - mask + 1;
  let rowVar = 0;
  const offs: number[] = [];
  if (numVar > 0) {
    if (f.jet3) {
      rowVar = db.u8(last - mask);
      let jumps = Math.floor((last - start) / 256);
      const colPtr = last - mask - jumps - 1;
      if (Math.floor((colPtr - start - rowVar) / 256) < jumps) jumps--;
      let used = 0;
      for (let i = 0; i <= rowVar; i++) {
        while (used < jumps && i === db.u8(last - mask - used - 1)) used++;
        offs.push(db.u8(colPtr - i) + used * 256);
      }
    } else {
      rowVar = db.u16(last - mask - 1);
      for (let i = 0; i <= rowVar; i++) offs.push(db.u16(last - mask - 3 - i * 2));
    }
  }
  const rowFixed = rowCols - rowVar;
  let fixedFound = 0;
  const out: Record<string, string> = {};
  for (const c of cols) {
    const present = (db.u8(nulls + (c.num >> 3)) & (1 << (c.num & 7))) !== 0;
    if (c.type === 1) { out[c.name] = present ? 'True' : 'False'; if (c.fixed) fixedFound++; continue; }
    let p = -1, size = 0;
    if (c.fixed && fixedFound < rowFixed) { p = start + countSize + c.fixedOff; size = c.size; fixedFound++; }
    else if (!c.fixed && c.varNum < rowVar) { p = start + offs[c.varNum]!; size = offs[c.varNum + 1]! - offs[c.varNum]!; }
    out[c.name] = present && p >= 0 && size >= 0 && p + size <= end ? value(db, c, p, size, present) : '';
  }
  return out;
}

function tableRows(db: Db, tdefPage: number): JetTable {
  const t = db.tdef(tdefPage);
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const numVar = dv.getUint16(db.f.numVarCols, true);
  const { cols, usage } = columnsOf(db, t);
  const rows: Record<string, string>[] = [];
  for (const pg of usagePages(db, usage[0], usage[1], tdefPage)) {
    const base = pg * db.f.pg;
    const count = db.u16(base + db.f.dataRowCount);
    for (let r = 0; r < count; r++) {
      const row = db.row(pg, r);
      if (!row || row.deleted || row.overflow) continue;
      try { rows.push(crack(db, cols, numVar, row.start, row.end)); } catch { /* a broken row */ }
    }
  }
  return { name: '', columns: cols.map((c) => c.name), rows };
}

/** The database's user tables (not its system tables, queries or links), each with its columns and rows. */
export function readJet(bytes: Uint8Array): JetTable[] {
  const db = new Db(bytes);
  const cat = tableRows(db, 2);
  if (!cat.columns.includes('Name') || !cat.columns.includes('Type')) throw new Error('the database\'s catalogue (MSysObjects) can\'t be read');
  const out: JetTable[] = [];
  for (const r of cat.rows) {
    const flags = Number(r.Flags ?? 0) >>> 0;
    if (r.Type !== '1' || !r.Name || /^MSys/i.test(r.Name) || (flags & 0x80000002) !== 0) continue;
    const tdef = (Number(r.Id) >>> 0) & 0x00ffffff;
    try { const t = tableRows(db, tdef); out.push({ name: r.Name, columns: t.columns, rows: t.rows }); } catch { /* unreadable: left out */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
