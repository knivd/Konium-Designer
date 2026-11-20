import { describe, expect, it } from 'vitest';
import { readXls, rk, isDateFormat, numText } from '../src/formats/db/xls';
import { readJet } from '../src/formats/db/jet';
import { createColumns, readSqlite } from '../src/formats/db/sqlite';
import { readTables } from '../src/formats/table';
import { readDbLib, writeDbLib, dbSource, dbDefaults, searchPaths, newDbLib, setDbFile } from '../src/formats/altium/dblib';
import { effectiveMaps, newTable, readFieldMap, reserved, iniBytes } from '../src/formats/altium/dbFile';
import { readDbLink } from '../src/formats/altium/dblink';
import { detect, load } from '../src/formats/registry';
import { dbPartRecords, findDbRecord, recordKey, recordModels, recordParams, whereMatches } from '../src/model/dbLibParts';
import { dbParamChanges, type DbPart } from '../src/model/dbParams';
import { demoFiles } from '../src/formats/synthetic/demo';
import { SR } from '../src/model/sch';
import { folderFromFiles, loadDbLib, recordFootprint, recordSymbol } from '../src/app/dbLib';
import { makeJet, makeXls } from './tools/dbFixtures';

/* An AD-style library on an Access database: the key's mapping and the bracketed ones written, the others left to the default */
const SAMPLE = [
  '[OutputDatabaseLinkFile]', 'Version=1.1', '[DatabaseLinks]',
  'ConnectionString=Provider=Microsoft.ACE.OLEDB.12.0;Data Source=C:\\Libraries\\Parts.mdb;Persist Security Info=False',
  'AddMode=3', 'RemoveMode=1', 'UpdateMode=2', 'ViewMode=0', 'LeftQuote=[', 'RightQuote=]', 'QuoteTableNames=1', 'UseTableSchemaName=0', 'DefaultColumnType=VARCHAR(255)',
  'LibraryDatabaseType=Microsoft Access', 'LibraryDatabasePath=Parts.mdb', 'DatabasePathRelative=1', 'TopPanelCollapsed=0', 'LibrarySearchPath=..\\Symbols;..\\Footprints',
  'OrcadMultiValueDelimiter=,', 'SearchSubDirectories=1', 'SchemaName=', 'LastFocusedTable=Resistors',
  '[Table1]', 'SchemaName=', 'TableName=Resistors', 'Enabled=True', 'UserWhere=0', 'UserWhereText=', 'BrowserOrder_Sorting=', 'BrowserOrder_Grouping=', 'BrowserOrder_Visible=Part Number0=120|Value0=60',
  '[Table2]', 'SchemaName=', 'TableName=Capacitors', 'Enabled=False', 'UserWhere=1', "UserWhereText=[Value] = '{Value}' AND [Voltage] >= {Voltage}",
  '[FieldMap1]', 'Options=FieldName=Resistors.Part Number|TableNameOnly=Resistors|FieldNameOnly=Part Number|FieldType=0|ParameterName=Part Number|VisibleOnAdd=False|AddMode=0|RemoveMode=0|UpdateMode=0',
  '[FieldMap2]', 'Options=FieldName=Resistors.Library Ref|TableNameOnly=Resistors|FieldNameOnly=Library Ref|FieldType=1|ParameterName=[Library Ref]|VisibleOnAdd=False|AddMode=0|RemoveMode=0|UpdateMode=0',
  '[FieldMap3]', 'Options=FieldName=Resistors.Value|TableNameOnly=Resistors|FieldNameOnly=Value|FieldType=1|ParameterName=Value|VisibleOnAdd=True|AddMode=0|RemoveMode=0|UpdateMode=1',
  '[FieldMap4]', 'Options=FieldName=Capacitors.Part Number|TableNameOnly=Capacitors|FieldNameOnly=Part Number|FieldType=0|ParameterName=Part Number|VisibleOnAdd=False|AddMode=0|RemoveMode=0|UpdateMode=0',
].join('\r\n') + '\r\n';

describe('database files', () => {
  it('Excel 97–2003 workbooks: shared strings over CONTINUE, RK and MULRK numbers, formula text, booleans, dates by format', () => {
    const [s] = readXls(makeXls());
    expect(s!.name).toBe('Parts');
    expect(s!.rows).toEqual([
      ['Part Number', 'Value', 'Qty', 'Price', 'Fitted', 'Added', 'Note'],
      ['R-1', '10k', '5', '0.25', 'TRUE', '2026-03-01', 'A long note that runs on'],
      ['C-2', '100nF', '12', '3.5', 'FALSE', '2026-03-01 12:00:00', '2.2 kΩ'],
    ]);
    expect([rk((7 << 2) | 2), rk((-3 << 2) | 2), rk((150 << 2) | 3)]).toEqual([7, -3, 1.5]);
    expect([isDateFormat('yyyy-mm-dd'), isDateFormat('0.00'), isDateFormat('"m"0'), isDateFormat('[h]:mm')]).toEqual([true, false, false, true]);
    expect([numText(0.1 + 0.2), numText(1e21), numText(-4)]).toEqual(['0.3', '1e+21', '-4']);
  });
  it('Access (Jet 4) databases: the catalogue, a table\'s rows — compressed and wide text, numbers, Yes/No, dates, memos — deleted rows left out', async () => {
    const f = makeJet();
    expect(readJet(f.bytes)).toEqual(f.expect);
    const [t] = await readTables('Parts.mdb', f.bytes);
    expect(t!.rows.length).toBe(2);
  });
  it('SQLite databases: tables from their CREATE statements, the row id for an INTEGER PRIMARY KEY, overflow pages, interior pages', async () => {
    // Node's own SQLite writes the file (the modules by name: the app's types know no Node)
    const nodeMod = (n: string) => import(/* @vite-ignore */ n) as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const { DatabaseSync } = await nodeMod('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA page_size = 1024');
    db.exec('CREATE TABLE "Parts" (id INTEGER PRIMARY KEY, [Part Number] TEXT NOT NULL, `Value` TEXT, Qty INTEGER, Price REAL, Note TEXT, CONSTRAINT k UNIQUE ([Part Number]))');
    const ins = db.prepare('INSERT INTO Parts ("Part Number", Value, Qty, Price, Note) VALUES (?, ?, ?, ?, ?)');
    for (let i = 0; i < 1500; i++) ins.run(`P-${i}`, i % 2 ? '10k' : '2.2 kΩ', i - 700, i / 4, i === 7 ? 'Ω'.repeat(3000) : null);
    db.exec('CREATE VIEW v AS SELECT * FROM Parts');
    const { tmpdir } = await nodeMod('node:os');
    const path = `${tmpdir()}/dblib58-${Math.random().toString(36).slice(2)}.db`;
    const { readFileSync, rmSync } = await nodeMod('node:fs');
    db.exec(`VACUUM INTO '${path}'`);
    db.close();
    const bytes = new Uint8Array(readFileSync(path));
    rmSync(path);
    const [t] = readSqlite(bytes);
    expect(t!.columns).toEqual(['id', 'Part Number', 'Value', 'Qty', 'Price', 'Note']);
    expect(t!.rows.length).toBe(1500);
    expect(t!.rows[0]).toEqual({ id: '1', 'Part Number': 'P-0', Value: '2.2 kΩ', Qty: '-700', Price: '0', Note: '' });
    expect(t!.rows[1499]!['Price']).toBe('374.75');
    expect(t!.rows[7]!['Note']).toBe('Ω'.repeat(3000));
    expect(createColumns('CREATE TABLE x ("a""b" text, [c d], e integer primary key desc, PRIMARY KEY (a))')).toEqual({ columns: ['a"b', 'c d', 'e'], rowid: -1 });
  });
});

describe('database libraries', () => {
  it('read and write as AD does: byte for byte, the key from FieldType 0, the defaults and search paths', () => {
    const bytes = iniBytes(SAMPLE);
    expect(detect(bytes, 'Parts.DbLib')).toBe('DbLib');
    expect(detect(bytes, 'whatever.txt')).toBe('DbLib');
    const d = readDbLib(bytes, 'Parts.DbLib');
    expect(new TextDecoder().decode(writeDbLib(d))).toBe(SAMPLE);
    expect(d.tables.map((t) => [t.name, t.enabled, t.keyField, t.useWhere])).toEqual([['Resistors', true, 'Part Number', false], ['Capacitors', false, 'Part Number', true]]);
    expect(dbSource(d.links)).toMatchObject({ file: 'Parts.mdb', type: 'Microsoft Access', dsn: '' });
    expect(dbDefaults(d.links)).toEqual({ update: 'Update', add: 'Add only if not blank', remove: 'Do not remove' });
    expect(searchPaths(d.links)).toEqual({ paths: ['../Symbols', '../Footprints'], subDirs: true });
    // Every column's mapping: the file's, else the default (the parameter of its name)
    const maps = effectiveMaps(d.tables[0]!, ['Part Number', 'Value', 'Library Ref', 'Tolerance']);
    expect(maps.map((m) => [m.field, m.parameter, m.key, m.visible, m.update])).toEqual([
      ['Part Number', 'Part Number', true, false, 'Default'], ['Value', 'Value', false, true, 'Do not update'], ['Library Ref', '[Library Ref]', false, false, 'Default'], ['Tolerance', 'Tolerance', false, false, 'Default']]);
    // An ODBC library's data source is out of a browser's reach
    const odbc = readDbLib(iniBytes(SAMPLE.replace(/ConnectionString=.*\r\n/, 'ConnectionString=Provider=MSDASQL.1;Persist Security Info=False;Data Source=parts_dsn\r\n').replace('LibraryDatabasePath=Parts.mdb', 'LibraryDatabasePath=')), 'X.DbLib');
    expect(dbSource(odbc.links)).toMatchObject({ file: '', dsn: 'parts_dsn' });
    expect(readFieldMap('FieldName=T.F|TableNameOnly=T|FieldNameOnly=F|FieldType=1|ParameterName=[None]|VisibleOnAdd=True|AddMode=3|RemoveMode=2|UpdateMode=1'))
      .toEqual({ table: 'T', field: 'F', parameter: '', key: false, visible: true, update: 'Do not update', add: 'Add only if not blank', remove: 'Remove only if blank' });
    expect([reserved('Footprint Ref 2'), reserved('sim model name'), reserved('Value')]).toEqual(['[Footprint Ref 2]', '[Sim Model Name]', undefined]);
    // Links read Konium's own earlier layout still
    const old = readDbLink(iniBytes('[DatabaseLinks]\r\nConnectionString=Provider=Microsoft.ACE.OLEDB.12.0;Data Source=P.xlsx\r\nUpdateMode=1\r\nAddMode=2\r\n[Table1]\r\nTableName=P$\r\nEnabled=True\r\nKeyField=Part Number\r\nKeyParameter=PN\r\nFieldMapCount=1\r\nFieldMap1=Field=Value|Parameter=Value|Update=Do not update|Add=Default|Visible=True\r\n'), 'L.DbLink');
    expect([old.source, old.tables[0]!.keyField, old.tables[0]!.keyParameter, old.tables[0]!.maps[0]!.update]).toEqual(['P.xlsx', 'Part Number', 'PN', 'Do not update']);
  });
  it('Where clauses: fields, {parameters}, AND / OR / NOT, comparisons, LIKE', () => {
    const row = { 'Part Number': 'C-1', Value: '100nF', Voltage: '50', Package: '0603' };
    const p = (m: Record<string, string>) => (n: string) => m[n];
    expect(whereMatches("[Value] = '{Value}' AND [Voltage] >= {Voltage}", p({ Value: '100NF', Voltage: '25' }), row)).toBe(true);
    expect(whereMatches("[Value] = '{Value}' AND [Voltage] >= {Voltage}", p({ Value: '100nF', Voltage: '63' }), row)).toBe(false);
    expect(whereMatches("([Package] = '0805' OR [Package] LIKE '06%') AND NOT [Value] <> '100nF'", p({}), row)).toBe(true);
    expect(whereMatches("[Part Number] = 'C-''1'", p({}), { 'Part Number': "C-'1" })).toBe(true);
  });
  it('the demo library: its records place as parts — symbol, description, parameters, footprint, the table and key — and update from the database', async () => {
    const files = demoFiles();
    const f = files.find((x) => x.name === 'Demo.DbLib')!;
    const doc = load(f.bytes, f.name);
    expect(doc.kind).toBe('DbLib');
    if (doc.kind !== 'DbLib') return;
    const folder = folderFromFiles('Demo.DbLib', files);
    const data = await loadDbLib({ key: 't', name: 'Demo.DbLib', doc: () => doc, folder: () => folder });
    expect(data.error).toBeUndefined();
    const t = doc.tables[0]!, table = data.tables[0]!;
    expect([t.name, table.name, table.rows.length]).toEqual(['Parts$', 'Parts$', 6]);
    const row = table.rows.find((r) => r['Part Number'] === 'RES-0805-10K')!;
    const m = recordModels(t, table.columns, row);
    expect(m).toEqual({ libRef: 'Res', libPath: 'Demo.SchLib', description: 'Resistor, 10 kΩ, 1 %, 0805', footprints: [{ ref: '0805', path: 'Demo.PcbLib' }] });
    expect(recordKey(t, table.columns, row)).toBe('RES-0805-10K');
    expect(recordParams(t, table.columns, row, dbDefaults(doc.links)).map((x) => `${x.name}=${x.value}${x.visible ? ' (shown)' : ''}`))
      .toEqual(['Part Number=RES-0805-10K', 'Comment=10k', 'Value=10k (shown)', 'Manufacturer=Generic', 'Manufacturer Part Number=R0805-10K-1%']);
    const sym = recordSymbol(data, m.libPath, m.libRef)!;
    expect(sym.sym.libRef).toBe('Res');
    expect(recordFootprint(data, 'Demo.PcbLib', '0805')!.footprint.name).toBe('0805');
    const items = dbPartRecords(sym.sym, 'Demo.DbLib', t, table.columns, row, dbDefaults(doc.links));
    const comp = items[0]!.bag;
    expect(['SOURCELIBRARYNAME', 'DATABASETABLENAME', 'DESIGNITEMID', 'LIBREFERENCE', 'COMPONENTDESCRIPTION'].map((k) => comp.get(k))).toEqual(['Demo.DbLib', 'Parts$', 'RES-0805-10K', 'Res', 'Resistor, 10 kΩ, 1 %, 0805']);
    const params = items.filter((i) => i.owner === 0 && i.bag.int('RECORD') === SR.PARAMETER).map((i) => `${i.bag.get('NAME')}=${i.bag.get('TEXT')}${i.bag.bool('ISHIDDEN') ? '' : ' (shown)'}`);
    expect(params).toEqual(expect.arrayContaining(['Comment=10k (shown)', 'Value=10k (shown)', 'Part Number=RES-0805-10K', 'Manufacturer Part Number=R0805-10K-1%']));
    const fps = items.filter((i) => i.bag.int('RECORD') === SR.IMPLEMENTATION).map((i) => [i.bag.get('MODELNAME'), i.bag.get('MODELDATAFILE0'), i.bag.bool('ISCURRENT')]);
    expect(fps).toEqual([['0805', 'Demo.PcbLib', true]]);
    // Owners stay within the records (the implementation under the list, its own children under it)
    items.forEach((it, i) => { if (i) expect(it.owner).toBeLessThan(i); });
    // Update Parameters From Database: by the part's table and key
    const part = (params: Record<string, string>, table = 'Parts$'): DbPart => ({ sheet: 'A.SchDoc', index: 1, designator: 'R1', table, library: 'Demo.DbLib', params: new Map(Object.entries(params).map(([k, v]) => [k.toUpperCase(), { name: k, value: v }])) });
    const r = dbParamChanges([part({ 'Part Number': 'RES-0805-10K', Value: '1k', Comment: '10k' }), part({ 'Part Number': 'NOPE' })], { tables: doc.tables, defaults: dbDefaults(doc.links) }, data.tables, (x) => x.table);
    expect(r.matched).toBe(1);
    expect(r.unmatched).toEqual(['R1']);
    expect(r.changes.map((c) => `${c.parameter}: ${c.from ?? '(new)'} → ${c.to}`)).toEqual(['Value: 1k → 10k', 'Manufacturer: (new) → Generic', 'Manufacturer Part Number: (new) → R0805-10K-1%']);
    expect(findDbRecord({ ...t, useWhere: true, where: "[Value] = '{Value}' AND [Library Ref] = 'Cap'" }, table, (n) => ({ Value: '10UF' } as Record<string, string>)[n])!['Part Number']).toBe('CAP-0805-10U');
  });
  it('a new library: Select Database Type writes the connection AD builds for the file', () => {
    const d = newDbLib('New.DbLib');
    setDbFile(d.links, 'Data/Parts.accdb');
    d.tables.push(newTable('Parts', ['Part Number', 'Library Ref', 'Footprint Ref', 'Value']));
    const back = readDbLib(writeDbLib(d), 'New.DbLib');
    expect(dbSource(back.links)).toMatchObject({ file: 'Data/Parts.accdb', type: 'Microsoft Access' });
    expect(back.tables[0]!.maps.map((m) => `${m.field}>${m.parameter}`)).toEqual(['Part Number>Part Number', 'Library Ref>[Library Ref]', 'Footprint Ref>[Footprint Ref]']);
  });
});
