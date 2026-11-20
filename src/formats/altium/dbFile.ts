/**
 * The file layout database links (.DbLink) and database libraries (.DbLib, .SVNDbLib) share:
 * a Windows INI — [OutputDatabaseLinkFile] Version, [DatabaseLinks] (the connection, default
 * actions, quoting, search paths), a [TableN] per table and a [FieldMapN] per field mapping,
 * its Options a |-separated list (FieldName=Table.Field|TableNameOnly|FieldNameOnly|FieldType
 * (0 the key of a single key lookup) |ParameterName|VisibleOnAdd|AddMode|RemoveMode|UpdateMode).
 * Sections and keys Konium doesn't edit are kept as read, in their order.
 */
import { binToBytes, bytesToBin, cp1252ToStr, toCp1252Lossy } from '../text';

export type Entries = [string, string][];
export interface IniSection { name: string; entries: Entries }

export function readIni(text: string): IniSection[] {
  const out: IniSection[] = [];
  let cur: IniSection | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^﻿/, '');
    const s = /^\s*\[(.+)\]\s*$/.exec(line);
    if (s) { cur = { name: s[1]!, entries: [] }; out.push(cur); continue; }
    const eq = line.indexOf('=');
    if (cur && eq > 0) cur.entries.push([line.slice(0, eq).trim(), line.slice(eq + 1)]);
  }
  return out;
}

export function writeIni(sections: IniSection[]): string {
  return sections.map((s) => [`[${s.name}]`, ...s.entries.map(([k, v]) => `${k}=${v}`)].join('\r\n')).join('\r\n') + '\r\n';
}

/** A file's text: UTF-8 when it decodes as such (with a BOM, or non-ASCII that is valid), else Windows-1252. */
export function iniText(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder().decode(bytes.subarray(3));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return cp1252ToStr(bytesToBin(bytes)); }
}
/** Text as AD writes these files: Windows-1252 (a character it can't hold as '?'). */
export const iniBytes = (text: string): Uint8Array => binToBytes(toCp1252Lossy(text));

export const section = (ini: IniSection[], name: string) => ini.find((s) => s.name.toLowerCase() === name.toLowerCase());
export const entry = (s: IniSection | Entries | undefined, key: string): string | undefined =>
  (Array.isArray(s) ? s : s?.entries)?.find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1];
export function setEntry(s: IniSection | Entries, key: string, value: string): void {
  const list = Array.isArray(s) ? s : s.entries;
  const e = list.find(([k]) => k.toLowerCase() === key.toLowerCase());
  if (e) e[1] = value; else list.push([key, value]);
}

/** Field mapping actions, in the order AD's menus list them. */
export const UPDATE_MODES = ['Default', 'Update', 'Do not update'] as const;
export const ADD_MODES = ['Default', 'Add', 'Do not add', 'Add only if not blank'] as const;
export const REMOVE_MODES = ['Default', 'Do not remove', 'Remove only if blank'] as const;
export type UpdateMode = typeof UPDATE_MODES[number];
export type AddMode = typeof ADD_MODES[number];
export type RemoveMode = typeof REMOVE_MODES[number];
/** Their numbers in the file: 0 Default (a field's) [est: the others, from AD's defaults 2 / 3 / 1 read as Update / Add only if not blank / Do not remove]. */
const UPDATE_NUM: Record<UpdateMode, number> = { Default: 0, 'Do not update': 1, Update: 2 };
const ADD_NUM: Record<AddMode, number> = { Default: 0, 'Do not add': 1, Add: 2, 'Add only if not blank': 3 };
const REMOVE_NUM: Record<RemoveMode, number> = { Default: 0, 'Do not remove': 1, 'Remove only if blank': 2 };
const fromNum = <T extends string>(table: Record<T, number>, n: string | undefined, d: T): T =>
  (Object.entries(table) as [T, number][]).find(([, v]) => String(v) === (n ?? '').trim())?.[0] ?? d;
export const updateMode = (n: string | undefined, d: UpdateMode = 'Default') => fromNum(UPDATE_NUM, n, d);
export const addMode = (n: string | undefined, d: AddMode = 'Default') => fromNum(ADD_NUM, n, d);
export const removeMode = (n: string | undefined, d: RemoveMode = 'Default') => fromNum(REMOVE_NUM, n, d);
export const updateNum = (m: UpdateMode) => UPDATE_NUM[m];
export const addNum = (m: AddMode) => ADD_NUM[m];
export const removeNum = (m: RemoveMode) => REMOVE_NUM[m];

/** One field's mapping: `key` is the single key lookup's (FieldType 0); `parameter` '' is [None]. */
export interface FieldMap {
  field: string; parameter: string; key: boolean; visible: boolean;
  update: UpdateMode; add: AddMode; remove: RemoveMode;
}

/** A FieldMap section's Options, split at | (values hold no |). */
export function readFieldMap(options: string): FieldMap & { table: string } {
  const o = new Map(options.split('|').map((p) => { const eq = p.indexOf('='); return [p.slice(0, eq).toLowerCase(), p.slice(eq + 1)] as [string, string]; }));
  const full = o.get('fieldname') ?? '';
  const table = o.get('tablenameonly') ?? (full.includes('.') ? full.slice(0, full.lastIndexOf('.')) : '');
  const field = o.get('fieldnameonly') ?? (full.includes('.') ? full.slice(full.lastIndexOf('.') + 1) : full);
  const p = o.get('parametername') ?? '';
  return {
    table, field, parameter: /^\[none\]$/i.test(p) ? '' : p, key: (o.get('fieldtype') ?? '1').trim() === '0',
    visible: /^(true|t|1)$/i.test(o.get('visibleonadd') ?? ''), update: updateMode(o.get('updatemode')), add: addMode(o.get('addmode')), remove: removeMode(o.get('removemode')),
  };
}

export function fieldMapOptions(table: string, m: FieldMap): string {
  return [`FieldName=${table}.${m.field}`, `TableNameOnly=${table}`, `FieldNameOnly=${m.field}`, `FieldType=${m.key ? 0 : 1}`, `ParameterName=${m.parameter || '[None]'}`,
    `VisibleOnAdd=${m.visible ? 'True' : 'False'}`, `AddMode=${addNum(m.add)}`, `RemoveMode=${removeNum(m.remove)}`, `UpdateMode=${updateNum(m.update)}`].join('|');
}

/** A table of a link or library: Enabled, the single key lookup or a Where clause, its fields' mappings, and its other keys as read (the Table Browser's column order …). */
export interface DbTable {
  name: string; enabled: boolean;
  /** SchemaName (a database's owner, as Oracle's): '' mostly. */
  schema: string;
  keyField: string; keyParameter: string;
  /** Use a Where clause (UserWhere) instead of the single key lookup. */
  useWhere: boolean; where: string;
  maps: FieldMap[];
  /** Its section's other keys. */
  rest: Entries;
}

/** The tables and their mappings of a file in this layout, the other sections as they are. */
export function readDbTables(ini: IniSection[]): { tables: DbTable[]; others: IniSection[] } {
  const tables: DbTable[] = [];
  const maps: (FieldMap & { table: string })[] = [];
  const others: IniSection[] = [];
  for (const s of ini) {
    if (/^Table\d+$/i.test(s.name)) {
      tables.push({
        name: entry(s, 'TableName') ?? s.name, enabled: !/^(false|f|0)$/i.test(entry(s, 'Enabled') ?? 'True'), schema: entry(s, 'SchemaName') ?? '',
        keyField: '', keyParameter: '', useWhere: (entry(s, 'UserWhere') ?? '0').trim() === '1', where: entry(s, 'UserWhereText') ?? '', maps: [],
        rest: s.entries.filter(([k]) => !/^(SchemaName|TableName|Enabled|UserWhere|UserWhereText)$/i.test(k)),
      });
    } else if (/^FieldMap\d+$/i.test(s.name)) {
      const o = entry(s, 'Options');
      if (o !== undefined) maps.push(readFieldMap(o));
    } else others.push(s);
  }
  for (const m of maps) {
    const t = tables.find((x) => x.name.toLowerCase() === m.table.toLowerCase());
    if (!t) continue;
    const { table: _t, ...map } = m;
    t.maps.push(map);
  }
  for (const t of tables) {
    const k = t.maps.find((m) => m.key);
    t.keyField = k?.field ?? '';
    t.keyParameter = k?.parameter || k?.field || '';
  }
  return { tables, others };
}

/** A field's mapping as it is when the file doesn't name it: to the parameter of its name, Default actions, hidden. */
export const defaultMap = (field: string): FieldMap => ({ field, parameter: field, key: false, visible: false, update: 'Default', add: 'Default', remove: 'Default' });
const isDefault = (m: FieldMap) => !m.key && m.parameter === m.field && !m.visible && m.update === 'Default' && m.add === 'Default' && m.remove === 'Default';

/** Every column's mapping: the file's where it names one, the default where not (AD writes only those it must). */
export function effectiveMaps(t: DbTable, columns: string[]): FieldMap[] {
  const out = columns.map((c) => {
    const m = t.maps.find((x) => x.field.toLowerCase() === c.toLowerCase());
    const key = !!t.keyField && c.toLowerCase() === t.keyField.toLowerCase();
    return m ? { ...m, field: c, key } : { ...defaultMap(c), key, parameter: key ? t.keyParameter || c : c };
  });
  // Mappings of fields the data doesn't have (yet) stay listed
  for (const m of t.maps) if (!columns.some((c) => c.toLowerCase() === m.field.toLowerCase())) out.push(m);
  return out;
}

/** The Table and FieldMap sections of these tables, numbered from 1: a FieldMap for the key and for each mapping that isn't the default. */
export function tableSections(tables: DbTable[]): IniSection[] {
  const out: IniSection[] = [];
  tables.forEach((t, i) => {
    out.push({ name: `Table${i + 1}`, entries: [['SchemaName', t.schema], ['TableName', t.name], ['Enabled', t.enabled ? 'True' : 'False'],
      ['UserWhere', t.useWhere ? '1' : '0'], ['UserWhereText', t.where], ...t.rest] });
  });
  let n = 0;
  for (const t of tables) {
    const maps = [...t.maps];
    if (t.keyField && !maps.some((m) => m.field.toLowerCase() === t.keyField.toLowerCase())) maps.unshift({ ...defaultMap(t.keyField), key: true });
    for (const m of maps) {
      const key = !!t.keyField && m.field.toLowerCase() === t.keyField.toLowerCase();
      const map = { ...m, key, parameter: key ? t.keyParameter || m.field : m.parameter };
      if (isDefault(map)) continue;
      out.push({ name: `FieldMap${++n}`, entries: [['Options', fieldMapOptions(t.name, map)]] });
    }
  }
  return out;
}

/** A table as first mapped: every field to the parameter of its name; the key Part Number when there is one, else the first field. */
export function newTable(name: string, columns: string[]): DbTable {
  const key = columns.find((c) => /^part ?number$/i.test(c)) ?? columns.find((c) => /^(manufacturer part number|mpn|key|name|part name)$/i.test(c)) ?? columns[0] ?? '';
  return {
    name, enabled: true, schema: '', keyField: key, keyParameter: key, useWhere: false, where: key ? `[${key}] = '{${key}}'` : '', rest: [],
    maps: columns.map((c) => ({ field: c, parameter: reserved(c) ?? c, key: c === key, visible: false, update: 'Default', add: 'Default', remove: 'Default' })),
  };
}

/** The fields AD maps to its bracketed names (the symbol, footprints, description …) on its own. */
export function reserved(field: string): string | undefined {
  const f = field.trim();
  const m = /^(library ref|library path|footprint ref|footprint path|description|pcb3d ref|pcb3d path|orcad library|orcad footprint|sim (?:model name|file|kind|subkind|netlist|spice prefix|port map|excluded parts|parameters|description))(?: (\d+))?$/i.exec(f);
  if (!m) return undefined;
  const words = m[1]!.split(' ').map((w) => (/^(pcb3d|orcad)$/i.test(w) ? ({ pcb3d: 'PCB3D', orcad: 'Orcad' } as Record<string, string>)[w.toLowerCase()]! : w[0]!.toUpperCase() + w.slice(1).toLowerCase()));
  const name = words.join(' ').replace('Subkind', 'SubKind');
  return `[${name}${m[2] ? ` ${m[2]}` : ''}]`;
}

/** The Data Source of an OLE DB connection string ('/'-separated). */
export function dataSource(conn: string): string {
  const m = /(?:^|;)\s*Data Source\s*=\s*("([^"]*)"|[^;]*)/i.exec(conn);
  return (m?.[2] ?? m?.[1] ?? '').trim().replace(/\\/g, '/');
}

/** The connection string AD builds for an Access database or an Excel workbook [est: the Excel one's Extended Properties]. */
export function connectionString(source: string): string {
  const win = source.replace(/\//g, '\\');
  if (/\.(mdb|accdb)$/i.test(source)) return `Provider=Microsoft.ACE.OLEDB.12.0;Data Source=${win};Persist Security Info=False`;
  if (/\.csv$/i.test(source)) return `Provider=Microsoft.ACE.OLEDB.12.0;Data Source=${win};Extended Properties="text;HDR=YES;FMT=Delimited"`;
  if (/\.xls$/i.test(source)) return `Provider=Microsoft.ACE.OLEDB.12.0;Data Source=${win};Extended Properties="Excel 8.0;HDR=Yes;IMEX=1"`;
  return `Provider=Microsoft.ACE.OLEDB.12.0;Data Source=${win};Extended Properties="Excel 12.0 Xml;HDR=YES;IMEX=1"`;
}

/** The database type AD's Select Database Type names for a data file. */
export const databaseType = (source: string): string => (/\.(mdb|accdb)$/i.test(source) ? 'Microsoft Access' : /\.(xlsx?|csv)$/i.test(source) ? 'Microsoft Excel' : '');
