/**
 * SQLite 3 database files (.db, .sqlite): the schema table and every ordinary table's rows,
 * read from the file's table b-trees (interior and leaf pages, overflow chains), each record's
 * values as text; columns named by the table's CREATE TABLE statement, an INTEGER PRIMARY KEY
 * taking the row id. A database library kept in SQLite (through its ODBC driver) reads this way.
 */
import { numText } from './xls';

export interface SqliteTable { name: string; columns: string[]; rows: Record<string, string>[] }

const MAGIC = 'SQLite format 3\u0000';
export function isSqlite(b: Uint8Array): boolean {
  return b.length >= 100 && String.fromCharCode(...b.subarray(0, 16)) === MAGIC;
}

class File {
  readonly dv: DataView;
  readonly size: number;
  readonly usable: number;
  readonly enc: number;
  constructor(readonly b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const s = this.dv.getUint16(16, false);
    this.size = s === 1 ? 65536 : s;
    this.usable = this.size - b[20]!;
    this.enc = this.dv.getUint32(56, false) || 1;
  }
  page(n: number): number {
    const at = (n - 1) * this.size;
    if (n < 1 || at + this.size > this.b.length) throw new Error(`page ${n} is outside the file`);
    return at;
  }
  varint(p: number): [number, number] {
    let v = 0n;
    for (let i = 0; i < 9; i++) {
      const x = this.b[p + i]!;
      if (i === 8) return [Number((v << 8n) | BigInt(x)), 9];
      v = (v << 7n) | BigInt(x & 0x7f);
      if (!(x & 0x80)) return [Number(v), i + 1];
    }
    return [Number(v), 9];
  }
  text(raw: Uint8Array): string {
    if (this.enc === 1) return new TextDecoder().decode(raw);
    return new TextDecoder(this.enc === 2 ? 'utf-16le' : 'utf-16be').decode(raw);
  }
  /** A leaf cell's payload, gathered from its overflow pages when it doesn't fit. */
  payload(p: number, len: number): Uint8Array {
    const U = this.usable, X = U - 35;
    if (len <= X) return this.b.subarray(p, p + len);
    const M = Math.floor(((U - 12) * 32) / 255) - 23;
    let local = M + ((len - M) % (U - 4));
    if (local > X) local = M;
    const out = new Uint8Array(len);
    out.set(this.b.subarray(p, p + local), 0);
    let o = local, next = this.dv.getUint32(p + local, false), guard = 0;
    while (next && o < len && guard++ < 1_000_000) {
      const at = this.page(next);
      const n = Math.min(U - 4, len - o);
      out.set(this.b.subarray(at + 4, at + 4 + n), o);
      o += n;
      next = this.dv.getUint32(at, false);
    }
    return out;
  }
  /** Every row of a table b-tree, in row id order: [rowid, values]. */
  rows(root: number, visit: (rowid: number, values: (string | null)[]) => void, depth = 0): void {
    if (depth > 64) throw new Error('a b-tree too deep');
    const at = this.page(root), h = at + (root === 1 ? 100 : 0);
    const kind = this.b[h]!;
    const cells = this.dv.getUint16(h + 3, false);
    const ptrs = h + (kind === 0x05 ? 12 : 8);
    if (kind === 0x05) {
      for (let i = 0; i < cells; i++) this.rows(this.dv.getUint32(at + this.dv.getUint16(ptrs + 2 * i, false), false), visit, depth + 1);
      this.rows(this.dv.getUint32(h + 8, false), visit, depth + 1);
      return;
    }
    if (kind !== 0x0d) throw new Error(`page ${root} isn't a table page`);
    for (let i = 0; i < cells; i++) {
      let p = at + this.dv.getUint16(ptrs + 2 * i, false);
      const [len, a] = this.varint(p); p += a;
      const [rowid, b] = this.varint(p); p += b;
      visit(rowid, this.record(this.payload(p, len)));
    }
  }
  record(r: Uint8Array): (string | null)[] {
    const dv = new DataView(r.buffer, r.byteOffset, r.byteLength);
    const vi = (p: number): [number, number] => { let v = 0; for (let i = 0; i < 9; i++) { const x = r[p + i] ?? 0; if (i === 8) return [v * 256 + x, 9]; v = v * 128 + (x & 0x7f); if (!(x & 0x80)) return [v, i + 1]; } return [v, 9]; };
    const [hl, n0] = vi(0);
    const types: number[] = [];
    for (let p = n0; p < hl;) { const [t, n] = vi(p); types.push(t); p += n; }
    const out: (string | null)[] = [];
    let p = hl;
    const int = (n: number) => { let v = 0n; for (let i = 0; i < n; i++) v = (v << 8n) | BigInt(r[p + i] ?? 0); if (n && (r[p]! & 0x80)) v -= 1n << BigInt(8 * n); return v.toString(); };
    for (const t of types) {
      if (t === 0) out.push(null);
      else if (t >= 1 && t <= 6) { const n = [0, 1, 2, 3, 4, 6, 8][t]!; out.push(int(n)); p += n; }
      else if (t === 7) { out.push(numText(dv.getFloat64(p, false))); p += 8; }
      else if (t === 8) out.push('0');
      else if (t === 9) out.push('1');
      else if (t >= 12 && t % 2 === 0) { const n = (t - 12) / 2; out.push([...r.subarray(p, p + n)].map((x) => x.toString(16).padStart(2, '0')).join('')); p += n; }
      else if (t >= 13) { const n = (t - 13) / 2; out.push(this.text(r.subarray(p, p + n))); p += n; }
      else out.push(null);
    }
    return out;
  }
}

/** A CREATE TABLE statement's column names, and which one (if any) is the row id's INTEGER PRIMARY KEY. */
export function createColumns(sql: string): { columns: string[]; rowid: number } {
  const open = sql.indexOf('(');
  if (open < 0) return { columns: [], rowid: -1 };
  // Top-level comma-separated definitions within the outer brackets
  const defs: string[] = [];
  let depth = 0, cur = '', q = '';
  for (let i = open + 1; i < sql.length; i++) {
    const c = sql[i]!;
    if (q) { cur += c; if (c === q) q = ''; continue; }
    if (c === '"' || c === "'" || c === '`') { q = c; cur += c; continue; }
    if (c === '[') { q = ']'; cur += c; continue; }
    if (c === '(') depth++;
    if (c === ')') { if (depth === 0) { defs.push(cur); break; } depth--; }
    if (c === ',' && depth === 0) { defs.push(cur); cur = ''; continue; }
    cur += c;
  }
  const columns: string[] = [];
  let rowid = -1;
  for (const d of defs) {
    const t = d.trim();
    if (/^(constraint|primary\s+key|unique|check|foreign\s+key)\b/i.test(t)) continue;
    const m = /^("([^"]|"")*"|\[[^\]]*\]|`([^`]|``)*`|'([^']|'')*'|\S+)/.exec(t);
    if (!m) continue;
    let name = m[1]!;
    if (/^["`']/.test(name)) name = name.slice(1, -1).replace(new RegExp(`${name[0]}${name[0]}`, 'g'), name[0]!);
    else if (name.startsWith('[')) name = name.slice(1, -1);
    const rest = t.slice(m[0].length);
    if (/^\s*integer\b[^,]*\bprimary\s+key\b/i.test(rest) && !/\bdesc\b/i.test(rest)) rowid = columns.length;
    columns.push(name);
  }
  return { columns, rowid };
}

/** The database's ordinary tables (not its own sqlite_ ones, views or WITHOUT ROWID tables). */
export function readSqlite(bytes: Uint8Array): SqliteTable[] {
  if (!isSqlite(bytes)) throw new Error('not an SQLite database');
  const f = new File(bytes);
  const schema: { type: string; name: string; root: number; sql: string }[] = [];
  f.rows(1, (_, v) => schema.push({ type: v[0] ?? '', name: v[1] ?? '', root: Number(v[3] ?? 0), sql: v[4] ?? '' }));
  const out: SqliteTable[] = [];
  for (const s of schema) {
    if (s.type !== 'table' || /^sqlite_/i.test(s.name) || !s.root || /\bwithout\s+rowid\b/i.test(s.sql)) continue;
    const { columns, rowid } = createColumns(s.sql);
    const rows: Record<string, string>[] = [];
    try {
      f.rows(s.root, (id, v) => {
        const r: Record<string, string> = {};
        columns.forEach((c, i) => { r[c] = i === rowid && v[i] === null ? String(id) : (v[i] ?? ''); });
        rows.push(r);
      });
    } catch { continue; }
    out.push({ name: s.name, columns, rows });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
