/**
 * Tables for database links and libraries: a CSV (comma, semicolon or tab separated, quoted
 * fields), an Excel workbook's worksheets (.xlsx, or .xls from Excel 97–2003), an Access
 * database's tables (.mdb, .accdb) or an SQLite database's, as columns and records keyed by them.
 */
import { isJet, readJet } from './db/jet';
import { isSqlite, readSqlite } from './db/sqlite';
import { isXls, readXls } from './db/xls';
import { readXlsx } from './xlsxRead';

export interface DataTable { name: string; columns: string[]; rows: Record<string, string>[] }

/** CSV text as rows of fields: "quoted, fields" with "" for a quote, the separator guessed from the first line. */
export function parseCsv(text: string): string[][] {
  const t = text.replace(/^﻿/, '');
  const first = t.split(/\r?\n/, 1)[0] ?? '';
  const sep = [',', ';', '\t'].map((c) => [c, first.split(c).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let row: string[] = [], cur = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (q) {
      if (ch === '"' && t[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"' && !cur) q = true;
    else if (ch === sep) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cur += ch;
  }
  row.push(cur);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

/** Rows (header first) as a table; blank or repeated headers get Column N names. */
export function toTable(name: string, rows: string[][]): DataTable {
  const head = rows[0] ?? [];
  const seen = new Set<string>();
  const columns = head.map((h, i) => { let n = h.trim() || `Column ${i + 1}`; while (seen.has(n.toLowerCase())) n = `${n}_${i + 1}`; seen.add(n.toLowerCase()); return n; });
  return { name, columns, rows: rows.slice(1).map((r) => Object.fromEntries(columns.map((c, i) => [c, (r[i] ?? '').trim()]))) };
}

/** The data files a database link or library can name. */
export const DATA_EXTS = ['.xlsx', '.xls', '.csv', '.mdb', '.accdb', '.db', '.sqlite', '.sqlite3', '.db3'];

/** The tables of a data file: a CSV is one table (named after the file), a workbook one per worksheet (Sheet1$ …, as Excel's OLE DB names them), a database its tables. */
export async function readTables(name: string, bytes: Uint8Array): Promise<DataTable[]> {
  if (isJet(bytes)) return readJet(bytes);
  if (isSqlite(bytes)) return readSqlite(bytes);
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && isXls(bytes)) return readXls(bytes).map((s) => toTable(`${s.name}$`, s.rows));
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const { sheets } = await readXlsx(bytes);
    const out: DataTable[] = [];
    for (const s of sheets) out.push(toTable(`${s}$`, (await readXlsx(bytes, s)).rows));
    return out;
  }
  if (/\.(csv|txt|tsv)$/i.test(name)) return [toTable(name.replace(/^.*[\\/]/, ''), parseCsv(new TextDecoder().decode(bytes)))];
  throw new Error(`${name}: Konium Designer reads Excel workbooks (.xlsx, .xls), CSV files, Access databases (.mdb, .accdb) and SQLite databases, not this file`);
}
