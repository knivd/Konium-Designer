/**
 * Database libraries (.DbLib, and .SVNDbLib whose symbols and footprints sit in a repository):
 * a database whose tables' records are parts — each record's fields give the symbol ([Library
 * Ref] in [Library Path]), the footprints ([Footprint Ref], [Footprint Path], … 2 …), the
 * description and the parameters a placed part gets. The file is the link layout (dbFile.ts)
 * with the library's own keys in [DatabaseLinks]: LibraryDatabaseType / Path (relative or not),
 * LibrarySearchPath and SearchSubDirectories.
 */
import {
  addMode, connectionString, databaseType, dataSource, entry, iniBytes, iniText, readDbTables, readIni, removeMode, section, setEntry, tableSections, updateMode, writeIni,
  addNum, removeNum, updateNum, type AddMode, type DbTable, type Entries, type IniSection, type RemoveMode, type UpdateMode,
} from './dbFile';

export interface DbLibDocument {
  kind: 'DbLib';
  name: string;
  /** [DatabaseLinks], in its order (the connection, default actions, quoting, search paths …). */
  links: Entries;
  tables: DbTable[];
  /** The other sections ([OutputDatabaseLinkFile] first, anything an SVNDbLib adds), as read. */
  others: IniSection[];
  dirty: boolean;
}

export const isSvnDbLib = (name: string) => /\.svndblib$/i.test(name);

export function readDbLib(bytes: Uint8Array, name: string): DbLibDocument {
  const ini = readIni(iniText(bytes));
  const links = section(ini, 'DatabaseLinks')?.entries ?? [];
  const { tables, others } = readDbTables(ini);
  return { kind: 'DbLib', name, links, tables, others: others.filter((s) => s.name.toLowerCase() !== 'databaselinks'), dirty: false };
}

export function writeDbLib(d: DbLibDocument): Uint8Array {
  const head = d.others.filter((s) => s.name.toLowerCase() === 'outputdatabaselinkfile');
  const rest = d.others.filter((s) => s.name.toLowerCase() !== 'outputdatabaselinkfile');
  return iniBytes(writeIni([...(head.length ? head : [{ name: 'OutputDatabaseLinkFile', entries: [['Version', '1.1']] as Entries }]),
    { name: 'DatabaseLinks', entries: d.links }, ...tableSections(d.tables), ...rest]));
}

/** A new library, its keys as AD writes a new one. */
export function newDbLib(name: string): DbLibDocument {
  const links: Entries = [['ConnectionString', ''], ['AddMode', '3'], ['RemoveMode', '1'], ['UpdateMode', '2'], ['ViewMode', '0'], ['LeftQuote', '['], ['RightQuote', ']'],
    ['QuoteTableNames', '1'], ['UseTableSchemaName', '0'], ['DefaultColumnType', 'VARCHAR(255)'], ['LibraryDatabaseType', ''], ['LibraryDatabasePath', ''],
    ['DatabasePathRelative', '1'], ['TopPanelCollapsed', '0'], ['LibrarySearchPath', ''], ['OrcadMultiValueDelimiter', ','], ['SearchSubDirectories', '0'],
    ['SchemaName', ''], ['LastFocusedTable', '']];
  return { kind: 'DbLib', name, links, tables: [], others: [{ name: 'OutputDatabaseLinkFile', entries: [['Version', '1.1']] }], dirty: true };
}

/** Tools › Options › Default Actions: what a field's Default means. */
export interface DbDefaults { update: Exclude<UpdateMode, 'Default'>; add: Exclude<AddMode, 'Default'>; remove: Exclude<RemoveMode, 'Default'> }
const real = <T extends string>(v: T, d: Exclude<T, 'Default'>) => (v === 'Default' ? d : v) as Exclude<T, 'Default'>;
export function dbDefaults(links: Entries): DbDefaults {
  return {
    update: real(updateMode(entry(links, 'UpdateMode'), 'Update'), 'Update'),
    add: real(addMode(entry(links, 'AddMode'), 'Add only if not blank'), 'Add only if not blank'),
    remove: real(removeMode(entry(links, 'RemoveMode'), 'Do not remove'), 'Do not remove'),
  };
}
export function setDbDefaults(links: Entries, d: DbDefaults): void {
  setEntry(links, 'UpdateMode', String(updateNum(d.update)));
  setEntry(links, 'AddMode', String(addNum(d.add)));
  setEntry(links, 'RemoveMode', String(removeNum(d.remove)));
}

/**
 * Where the library's database is: a data file (its path relative to the library, '/'-separated
 * — or only its name when the file gave an absolute path, looked for beside the library [est]),
 * or an ODBC data source / server the browser can't reach (`dsn`).
 */
export interface DbSource { file: string; type: string; dsn: string; connection: string }
const winAbsolute = (p: string) => /^[a-z]:[\\/]/i.test(p) || /^[\\/]{2}/.test(p) || p.startsWith('/');
const baseName = (p: string) => p.replace(/\\/g, '/').split('/').pop() ?? p;

export function dbSource(links: Entries): DbSource {
  const conn = entry(links, 'ConnectionString') ?? '';
  const type = entry(links, 'LibraryDatabaseType') ?? '';
  const path = (entry(links, 'LibraryDatabasePath') ?? '').trim();
  const relative = (entry(links, 'DatabasePathRelative') ?? '0').trim() === '1';
  const file = (p: string) => (relative && !winAbsolute(p) ? p.replace(/\\/g, '/') : baseName(p));
  if (path) return { file: file(path), type, dsn: '', connection: conn };
  const ds = dataSource(conn);
  // A Data Source naming a file (a path or a name with an extension) is the database; else an ODBC DSN or a server
  if (ds && /\.[a-z0-9]{2,7}$/i.test(ds) && !/MSDASQL|SQLOLEDB|SQLNCLI|MSOLEDBSQL|OraOLEDB/i.test(conn)) return { file: winAbsolute(ds) ? baseName(ds) : ds, type: type || databaseType(ds), dsn: '', connection: conn };
  const udl = entry(links, 'DataLinkFile') ?? '';
  return { file: '', type, dsn: ds || udl || (conn ? conn.split(';')[0] ?? '' : ''), connection: conn };
}

/** Select Database Type: a data file at `rel` (relative to the library), the connection built for it. */
export function setDbFile(links: Entries, rel: string): void {
  setEntry(links, 'ConnectionString', connectionString(rel));
  setEntry(links, 'LibraryDatabaseType', databaseType(rel));
  setEntry(links, 'LibraryDatabasePath', rel.replace(/\//g, '\\'));
  setEntry(links, 'DatabasePathRelative', '1');
}

/** Symbol and Model Search Paths: the library's folders to look in, relative to it ('/'-separated), and whether their sub-folders are searched too. */
export function searchPaths(links: Entries): { paths: string[]; subDirs: boolean } {
  const raw = entry(links, 'LibrarySearchPath') ?? '';
  return { paths: raw.split(/[;|]/).map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean), subDirs: (entry(links, 'SearchSubDirectories') ?? '0').trim() === '1' };
}
export function setSearchPaths(links: Entries, paths: string[], subDirs: boolean): void {
  setEntry(links, 'LibrarySearchPath', paths.map((p) => p.replace(/\//g, '\\')).join(';'));
  setEntry(links, 'SearchSubDirectories', subDirs ? '1' : '0');
}

export { connectionString, dataSource };
