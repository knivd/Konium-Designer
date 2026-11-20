/**
 * Database link files (.DbLink): which database a project's parts take parameters from, how a
 * part finds its record (single key lookup: a database field equal to a part parameter, or a
 * Where clause) and which fields go to which parameters, with Update Values / Add To Design /
 * Remove From Design per field. AD's link layout (dbFile.ts); the data file is named by the
 * connection string's Data Source, relative to the DbLink. Links Konium 26.043–26.057 wrote in
 * its own earlier layout [est] read too.
 */
import {
  ADD_MODES, UPDATE_MODES, REMOVE_MODES, connectionString, dataSource, entry, iniBytes, iniText, newTable, readDbTables, readIni, section, setEntry, tableSections, writeIni,
  updateMode, addMode, type AddMode, type DbTable, type Entries, type FieldMap, type IniSection, type UpdateMode,
} from './dbFile';
import { dbDefaults, setDbDefaults, type DbDefaults } from './dblib';

export { ADD_MODES, UPDATE_MODES, REMOVE_MODES, connectionString, dataSource };
export type { AddMode, UpdateMode, FieldMap };
export type DbLinkTable = DbTable;

export interface DbLinkDocument {
  kind: 'DbLink';
  name: string;
  /** The data file, relative to the DbLink ('/'-separated). */
  source: string;
  tables: DbTable[];
  /** Tools › Options › Default Actions: what Default means. */
  defaults: DbDefaults;
  dirty: boolean;
  /** The connection string as read (an Access or ODBC one too): kept while its data source is. */
  connection?: string;
  /** [DatabaseLinks] and the other sections as read: kept. */
  links?: Entries;
  others?: IniSection[];
}

/** Konium's own earlier layout: KeyField / FieldMapCount / FieldMapN=Field=…|Parameter=… in each table. */
function readEarlier(ini: IniSection[], name: string): DbLinkDocument {
  const top = section(ini, 'DatabaseLinks')?.entries ?? [];
  const pick = <T extends string>(v: string | undefined, list: readonly T[], d: T): T => list.find((x) => x.toLowerCase() === (v ?? '').toLowerCase()) ?? d;
  const tables: DbTable[] = [];
  for (const s of ini.filter((x) => /^Table\d+$/i.test(x.name))) {
    const maps: FieldMap[] = [];
    const n = Number(entry(s, 'FieldMapCount') ?? 0);
    const keyField = entry(s, 'KeyField') ?? '';
    for (let k = 1; k <= n; k++) {
      const f = new Map((entry(s, `FieldMap${k}`) ?? '').split('|').map((p) => { const eq = p.indexOf('='); return [p.slice(0, eq).toLowerCase(), p.slice(eq + 1)] as [string, string]; }));
      if (!f.get('field')) continue;
      maps.push({ field: f.get('field')!, parameter: f.get('parameter') ?? '', key: f.get('field')!.toLowerCase() === keyField.toLowerCase(), update: pick(f.get('update'), UPDATE_MODES, 'Default'),
        add: pick(f.get('add'), ADD_MODES, 'Default'), remove: 'Default', visible: /^true$/i.test(f.get('visible') ?? '') });
    }
    tables.push({ name: entry(s, 'TableName') ?? s.name, enabled: !/^false$/i.test(entry(s, 'Enabled') ?? 'True'), schema: '', keyField, keyParameter: entry(s, 'KeyParameter') ?? keyField,
      useWhere: false, where: '', maps, rest: [] });
  }
  const conn = entry(top, 'ConnectionString') ?? '';
  return {
    kind: 'DbLink', name, source: dataSource(conn), tables, connection: conn || undefined, dirty: false,
    defaults: { update: entry(top, 'UpdateMode') === '0' ? 'Do not update' : 'Update', add: entry(top, 'AddMode') === '0' ? 'Do not add' : entry(top, 'AddMode') === '1' ? 'Add' : 'Add only if not blank', remove: 'Do not remove' },
  };
}

export function readDbLink(bytes: Uint8Array, name: string): DbLinkDocument {
  const ini = readIni(iniText(bytes));
  if (ini.some((s) => /^Table\d+$/i.test(s.name) && (entry(s, 'KeyField') !== undefined || entry(s, 'FieldMapCount') !== undefined))) return readEarlier(ini, name);
  const links = section(ini, 'DatabaseLinks')?.entries ?? [];
  const { tables, others } = readDbTables(ini);
  const conn = entry(links, 'ConnectionString') ?? '';
  return {
    kind: 'DbLink', name, source: dataSource(conn), tables, defaults: dbDefaults(links), dirty: false, connection: conn || undefined,
    links, others: others.filter((s) => s.name.toLowerCase() !== 'databaselinks'),
  };
}

export function writeDbLink(d: DbLinkDocument): Uint8Array {
  const conn = d.connection !== undefined && dataSource(d.connection) === d.source ? d.connection : d.source ? connectionString(d.source) : '';
  const links: Entries = d.links ? d.links.map(([k, v]) => [k, v]) : [['ConnectionString', ''], ['AddMode', '3'], ['RemoveMode', '1'], ['UpdateMode', '2'], ['ViewMode', '0'],
    ['LeftQuote', '['], ['RightQuote', ']'], ['QuoteTableNames', '1'], ['UseTableSchemaName', '0'], ['DefaultColumnType', 'VARCHAR(255)'], ['DatabasePathRelative', '1']];
  setEntry(links, 'ConnectionString', conn);
  setDbDefaults(links, d.defaults);
  const others = d.others ?? [];
  const head = others.filter((s) => s.name.toLowerCase() === 'outputdatabaselinkfile');
  return iniBytes(writeIni([...(head.length ? head : [{ name: 'OutputDatabaseLinkFile', entries: [['Version', '1.0']] as Entries }]),
    { name: 'DatabaseLinks', entries: links }, ...tableSections(d.tables), ...others.filter((s) => s.name.toLowerCase() !== 'outputdatabaselinkfile')]));
}

/** A new link to a data file: each table's fields mapped to parameters of the same name, Part Number (else the first field) the key [est]. */
export function newDbLink(name: string, source = ''): DbLinkDocument {
  return { kind: 'DbLink', name, source, tables: [], defaults: { update: 'Update', add: 'Add only if not blank', remove: 'Do not remove' }, dirty: true };
}

/** A table as the link first maps it (no bracketed names: a link only gives parameters). */
export function defaultTable(name: string, columns: string[]): DbTable {
  const t = newTable(name, columns);
  for (const m of t.maps) m.parameter = m.field;
  return t;
}

export { updateMode, addMode };
