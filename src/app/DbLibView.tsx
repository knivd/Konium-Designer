/**
 * A database library open in its tab [est: laid out from AD17's DbLib editor]: Source of
 * Connection (the database file — Access, Excel, CSV or SQLite — relative to the library, or
 * the connection string as read), Connect; the database's tables (Enable); for the table shown,
 * Field Mappings (Database Field Name, Design Parameter with AD's bracketed names, Update
 * Values, Add To Design, Visible On Add, Remove From Design) under its Field Settings (single
 * key lookup or Where clause) and the Table Browser; Default Actions and the Symbol and Model
 * Search Paths beside the tables.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { Grid } from './Dialog';
import { projects, tick, type OpenDoc, type Project } from './state';
import {
  ADD_MODES, REMOVE_MODES, UPDATE_MODES, defaultMap, effectiveMaps, entry, newTable,
  type AddMode, type DbTable, type FieldMap, type RemoveMode, type UpdateMode,
} from '../formats/altium/dbFile';
import { dbDefaults, dbSource, searchPaths, setDbDefaults, setDbFile, setSearchPaths, type DbLibDocument } from '../formats/altium/dblib';
import { DATA_EXTS, type DataTable } from '../formats/table';
import { addFolderFile, ctxOfDoc, databaseCopy, dbLibData, reloadDbLib, setDatabaseCopy } from './dbLib';
import { chooseDbLibFolder } from './dbLibActions';
import { pickFileHandle } from '../platform/fs';
import { projectFolder } from './actions';

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const RESERVED = ['[Library Ref]', '[Library Path]', '[Description]', '[Footprint Ref]', '[Footprint Path]', '[Footprint Ref 2]', '[Footprint Path 2]', '[Footprint Ref 3]', '[Footprint Path 3]',
  '[PCB3D Ref]', '[PCB3D Path]', '[Orcad Library]', '[Orcad Footprint]', '[Sim Model Name]', '[Sim File]', '[Sim Kind]', '[Sim SubKind]', '[Sim Netlist]', '[Sim Spice Prefix]', '[Sim Port Map]',
  '[Sim Excluded Parts]', '[Sim Parameters]', '[Sim Description]'];

const projectOf = (od: OpenDoc): Project | null => (od.projectId ? projects.value.find((p) => p.id === od.projectId) ?? null : null);

/** The stored mapping of a field (made from its default when the file has none), for editing. */
function mapFor(t: DbTable, field: string): FieldMap {
  let m = t.maps.find((x) => same(x.field, field));
  if (!m) { m = { ...defaultMap(field) }; t.maps.push(m); }
  return m;
}

export function DbLibView({ od }: { od: OpenDoc }) {
  void tick.value;
  const doc = od.doc as DbLibDocument;
  const p = projectOf(od);
  const ctx = ctxOfDoc(od.name, od.projectId);
  const data = ctx ? dbLibData(ctx) : 'loading';
  const [cur, setCur] = useState(0);
  const [tab, setTab] = useState<'map' | 'browse'>('map');
  const [filter, setFilter] = useState('');
  const [newPath, setNewPath] = useState('');
  const [, redraw] = useState(0);
  const changed = () => { doc.dirty = true; tick.value++; redraw((x) => x + 1); };
  const src = dbSource(doc.links);
  const tables: DataTable[] = data === 'loading' ? [] : data.tables;
  // The database's tables the library doesn't list yet: listed (all enabled for a new library, else off)
  useEffect(() => {
    if (data === 'loading' || !data.tables.length) return;
    const fresh = data.tables.filter((d) => !doc.tables.some((t) => same(t.name, d.name)));
    if (!fresh.length) return;
    const first = doc.tables.length === 0;
    for (const d of fresh) { const t = newTable(d.name, d.columns); t.enabled = first; doc.tables.push(t); }
    changed();
  }, [data]);
  const t = doc.tables[cur];
  const dt = t ? tables.find((d) => same(d.name, t.name)) : undefined;
  const columns = dt?.columns ?? t?.maps.map((m) => m.field) ?? [];
  const maps = useMemo(() => (t ? effectiveMaps(t, columns) : []), [t, columns.join('|'), tick.value]);
  const defaults = dbDefaults(doc.links);
  const sp = searchPaths(doc.links);
  const browse = async () => {
    const f = await pickFileHandle(DATA_EXTS, 'Databases: Access, Excel, CSV, SQLite', 'konium-dbdata');
    if (!f || !ctx) return;
    // A data source the browser can't reach: the copy is read in its place, the library keeps naming its own
    if (src.dsn && !src.file) { setDatabaseCopy(ctx, f); redraw((x) => x + 1); return; }
    // Its path from the library when it is in the project's folder, else its name (looked for beside the library)
    let rel = f.name;
    if (p?.dir && f.handle) {
      try {
        const at = await (await projectFolder(p)).resolve(f.handle);
        const libPath = (p.prj.documents.find((d) => same(d.split(/[\\/]/).pop()!, od.name)) ?? od.name).replace(/\\/g, '/');
        if (at) {
          const from = libPath.split('/').slice(0, -1);
          let i = 0;
          while (i < from.length && i < at.length - 1 && same(from[i]!, at[i]!)) i++;
          rel = [...from.slice(i).map(() => '..'), ...at.slice(i)].join('/');
        }
      } catch { /* outside the folder: by name */ }
    }
    setDbFile(doc.links, rel);
    addFolderFile(ctx, rel, f);
    changed();
  };
  const connect = () => { if (ctx) { reloadDbLib(ctx); tick.value++; } };
  const status = data === 'loading' ? 'Connecting...' : data.error ? `Not connected: ${data.error}` : `Connected: ${data.tables.length} table${data.tables.length === 1 ? '' : 's'}, ${data.sch.length + data.pcb.length} librar${data.sch.length + data.pcb.length === 1 ? 'y' : 'ies'} found`;
  const setDefault = (k: 'update' | 'add' | 'remove', v: string) => { setDbDefaults(doc.links, { ...defaults, [k]: v }); changed(); };
  const rows = dt ? (filter ? dt.rows.filter((r) => Object.values(r).some((v) => v.toLowerCase().includes(filter.toLowerCase()))) : dt.rows) : [];
  return (
    <div class="dblink dblib" aria-label={`Database library ${od.name}`}>
      <fieldset><legend>Source of Connection</legend>
        <div class="dbl-source">
          <span>Database</span>
          <input type="text" readOnly aria-label="Database file" value={src.file ? src.file.replace(/\//g, '\\') : src.dsn ? `${src.dsn} (ODBC data source)` : ''} placeholder="An Access database, Excel workbook, CSV or SQLite file" title={src.connection} />
          <button class="btn" onClick={() => void browse()}>Browse...</button>
          <button class="btn default" onClick={connect}>{data !== 'loading' && !data.error ? 'Reconnect' : 'Connect'}</button>
          <span class={data !== 'loading' && !data.error ? 'dbl-ok' : 'muted small'}>{status}</span>
        </div>
        <div class="dbl-conn muted small">{src.type ? `${src.type} · ` : ''}{entry(doc.links, 'ConnectionString') || 'No connection string yet'}</div>
        {ctx && databaseCopy(ctx) && <div class="dbl-conn small">Reading {databaseCopy(ctx)!.name} in place of {src.dsn} this session (the library still names its data source)</div>}
        {ctx && <div class="dbl-conn"><button class="btn" onClick={() => void chooseDbLibFolder(ctx)}>Choose Folder...</button> <span class="muted small">{ctx.project?.dir ? 'read from the project\'s folder; or choose a folder holding the library, its database and its symbol and footprint libraries' : 'the folder holding the library, its database and its symbol and footprint libraries'}</span></div>}
      </fieldset>
      <div class="dbl-main">
        <div class="dbl-tables">
          <div class="dbl-head">Tables</div>
          {doc.tables.map((x, i) => (
            <label key={x.name} class={`dbl-table${i === cur ? ' on' : ''}`} onMouseDown={() => setCur(i)}>
              <input type="checkbox" aria-label={`Enable ${x.name}`} checked={x.enabled} onChange={() => { x.enabled = !x.enabled; changed(); }} />{x.name}
              {tables.length > 0 && !tables.some((d) => same(d.name, x.name)) && <span class="muted small"> (not in the database)</span>}
            </label>
          ))}
          {!doc.tables.length && <p class="muted small">Connect to list the database's tables</p>}
          <fieldset><legend>Default Actions</legend>
            <label class="do-row"><span>Update Values</span><select aria-label="Default update" value={defaults.update} onChange={(e) => setDefault('update', (e.target as HTMLSelectElement).value)}>{UPDATE_MODES.slice(1).map((x) => <option key={x}>{x}</option>)}</select></label>
            <label class="do-row"><span>Add To Design</span><select aria-label="Default add" value={defaults.add} onChange={(e) => setDefault('add', (e.target as HTMLSelectElement).value)}>{ADD_MODES.slice(1).map((x) => <option key={x}>{x}</option>)}</select></label>
            <label class="do-row"><span>Remove From Design</span><select aria-label="Default remove" value={defaults.remove} onChange={(e) => setDefault('remove', (e.target as HTMLSelectElement).value)}>{REMOVE_MODES.slice(1).map((x) => <option key={x}>{x}</option>)}</select></label>
          </fieldset>
          <fieldset><legend>Symbol and Model Search Paths</legend>
            {sp.paths.map((x) => <div key={x} class="dbl-path"><span title={x}>{x.replace(/\//g, '\\')}</span><button class="btn" aria-label={`Remove ${x}`} onClick={() => { setSearchPaths(doc.links, sp.paths.filter((y) => y !== x), sp.subDirs); changed(); }}>×</button></div>)}
            {!sp.paths.length && <p class="muted small">None: libraries beside the library are looked in</p>}
            <div class="dbl-path"><input type="text" aria-label="New search path" placeholder="..\Libraries" value={newPath} onInput={(e) => setNewPath((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.stopPropagation()} />
              <button class="btn" disabled={!newPath.trim()} onClick={() => { setSearchPaths(doc.links, [...sp.paths, newPath.trim()], sp.subDirs); setNewPath(''); changed(); }}>Add</button></div>
            <label class="out-check"><input type="checkbox" checked={sp.subDirs} onChange={() => { setSearchPaths(doc.links, sp.paths, !sp.subDirs); changed(); }} />Search sub-folders</label>
          </fieldset>
        </div>
        <div class="dbl-right">
          <div class="out-tabs" role="tablist">
            <button role="tab" class={tab === 'map' ? 'on' : ''} onClick={() => setTab('map')}>Field Mappings</button>
            <button role="tab" class={tab === 'browse' ? 'on' : ''} onClick={() => setTab('browse')}>Table Browser</button>
          </div>
          {!t ? <p class="muted">No table chosen</p> : tab === 'map' ? <>
            <fieldset><legend>Field Settings</legend>
              <div class="dbl-key dbl-settings">
                <label class="out-check dbl-span"><input type="radio" name={`look-${od.id}`} checked={!t.useWhere} onChange={() => { t.useWhere = false; changed(); }} />Single key lookup</label>
                <span>Database field</span>
                <select aria-label="Key database field" disabled={t.useWhere} value={columns.find((c) => same(c, t.keyField)) ?? t.keyField} onChange={(e) => {
                  const f = (e.target as HTMLSelectElement).value; const was = t.keyField; t.keyField = f; if (!t.keyParameter || same(t.keyParameter, was)) t.keyParameter = f; changed(); }}>
                  {columns.map((f) => <option key={f} value={f}>{f}</option>)}</select>
                <span>Part parameter</span>
                <input type="text" aria-label="Key part parameter" disabled={t.useWhere} value={t.keyParameter} onInput={(e) => { t.keyParameter = (e.target as HTMLInputElement).value; changed(); }} onKeyDown={(e) => e.stopPropagation()} />
                <label class="out-check dbl-span"><input type="radio" name={`look-${od.id}`} checked={t.useWhere} onChange={() => { t.useWhere = true; if (!t.where.trim()) t.where = `[${t.keyField}] = '{${t.keyParameter || t.keyField}}'`; changed(); }} />Where clause</label>
                <textarea class="dbl-where dbl-span" aria-label="Where clause" rows={2} disabled={!t.useWhere} value={t.where} onInput={(e) => { t.where = (e.target as HTMLTextAreaElement).value; changed(); }} onKeyDown={(e) => e.stopPropagation()} />
              </div>
            </fieldset>
            <datalist id={`dbl-params-${od.id}`}>{RESERVED.map((r) => <option key={r} value={r} />)}<option value="[None]" /></datalist>
            <Grid cols={[
              { label: 'Database Field Name', width: '180px', get: (m: FieldMap) => <span class={m.key ? 'dbl-keyfield' : ''}>{m.field}{m.key ? ' (key)' : ''}</span> },
              { label: 'Design Parameter', width: 'minmax(140px, 1fr)', get: (m) => <input type="text" list={`dbl-params-${od.id}`} aria-label={`Parameter for ${m.field}`} disabled={m.key} value={m.key ? t.keyParameter : m.parameter || '[None]'}
                onInput={(e) => { const v = (e.target as HTMLInputElement).value; mapFor(t, m.field).parameter = /^\[none\]$/i.test(v.trim()) ? '' : v; changed(); }} onKeyDown={(e) => e.stopPropagation()} /> },
              { label: 'Update Values', width: '112px', get: (m) => <select disabled={m.key || /^\[/.test(m.parameter)} aria-label={`Update ${m.field}`} value={m.update} onChange={(e) => { mapFor(t, m.field).update = (e.target as HTMLSelectElement).value as UpdateMode; changed(); }}>{UPDATE_MODES.map((x) => <option key={x}>{x}</option>)}</select> },
              { label: 'Add To Design', width: '150px', get: (m) => <select disabled={m.key || /^\[/.test(m.parameter)} aria-label={`Add ${m.field}`} value={m.add} onChange={(e) => { mapFor(t, m.field).add = (e.target as HTMLSelectElement).value as AddMode; changed(); }}>{ADD_MODES.map((x) => <option key={x}>{x}</option>)}</select> },
              { label: 'Visible On Add', width: '82px', align: 'center', get: (m) => <input type="checkbox" aria-label={`Visible ${m.field}`} disabled={/^\[/.test(m.parameter)} checked={m.visible} onChange={() => { const x = mapFor(t, m.field); x.visible = !x.visible; changed(); }} /> },
              { label: 'Remove From Design', width: '140px', get: (m) => <select disabled={m.key || /^\[/.test(m.parameter)} aria-label={`Remove ${m.field}`} value={m.remove} onChange={(e) => { mapFor(t, m.field).remove = (e.target as HTMLSelectElement).value as RemoveMode; changed(); }}>{REMOVE_MODES.map((x) => <option key={x}>{x}</option>)}</select> },
            ]} rows={maps} empty="No fields: connect to the database" />
          </> : (
            dt ? <>
              <input type="search" class="lib-mask" aria-label="Filter records" placeholder="Filter" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.stopPropagation()} />
              <Grid cols={dt.columns.map((c) => ({ label: c, width: 'minmax(90px, 1fr)', get: (r: Record<string, string>) => r[c] ?? '' }))} rows={rows} empty="No records" />
              <span class="muted small">{rows.length} of {dt.rows.length} record{dt.rows.length === 1 ? '' : 's'}</span>
            </> : <p class="muted">{data === 'loading' ? 'Connecting...' : 'Connect to browse the table'}</p>
          )}
        </div>
      </div>
    </div>
  );
}
