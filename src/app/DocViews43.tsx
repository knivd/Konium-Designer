/**
 * Documents of 26.043 open in their tabs [est: laid out from AD17's] (the BOM document: BomDocView.tsx):
 * - a database link: the data file (an Excel workbook or a CSV), its tables (Enable), the
 *   single key lookup, the field mappings with Update Values / Add To Design, the Table Browser.
 */
import { useEffect, useState } from 'preact/hooks';
import { Grid } from './Dialog';
import { notify, projects, tick, type OpenDoc, type Project } from './state';
import { ADD_MODES, UPDATE_MODES, defaultTable, type AddMode, type DbLinkDocument, type UpdateMode } from '../formats/altium/dblink';
import { defaultMap, effectiveMaps, type DbTable, type FieldMap } from '../formats/altium/dbFile';
import type { DataTable } from '../formats/table';
import { chooseDataFile, linkTables } from './dbLink';

const projectOf = (od: OpenDoc): Project | null => (od.projectId ? projects.value.find((p) => p.id === od.projectId) ?? null : null);
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** The stored mapping of a field (made from its default when the file has none), for editing. */
function mapFor(t: DbTable, field: string): FieldMap {
  let m = t.maps.find((x) => same(x.field, field));
  if (!m) { m = { ...defaultMap(field) }; t.maps.push(m); }
  return m;
}

/* ─── Database link ──────────────────────────────────────────────────────────────────── */

export function DbLinkView({ od }: { od: OpenDoc }) {
  void tick.value;
  const link = od.doc as DbLinkDocument;
  const p = projectOf(od);
  const path = (p?.prj.documents.find((d) => same(d.split('/').pop()!, od.name)) ?? od.path ?? od.name).replace(/\\/g, '/');
  const [tables, setTables] = useState<DataTable[] | null>(null);
  const [cur, setCur] = useState(0);
  const [tab, setTab] = useState<'map' | 'browse'>('map');
  const [, redraw] = useState(0);
  const changed = () => { link.dirty = true; tick.value++; redraw((x) => x + 1); };
  const adopt = (t: DataTable[]) => {
    setTables(t);
    let added = false;
    for (const d of t) if (!link.tables.some((x) => same(x.name, d.name))) { link.tables.push(defaultTable(d.name, d.columns)); added = true; }
    if (added) changed(); else redraw((x) => x + 1);
  };
  useEffect(() => { let live = true; void linkTables(p, path, link).then((t) => { if (live && t) adopt(t); }); return () => { live = false; }; }, [od.id]);
  const connect = async () => {
    try { const t = (await linkTables(p, path, link)) ?? (await chooseDataFile(p, path, link)); if (t) { adopt(t); notify(`Connected: ${t.length} table${t.length === 1 ? '' : 's'}`); } }
    catch (e) { notify(`Couldn't read the data file: ${(e as Error).message}`, 'error'); }
  };
  const browse = async () => { try { const t = await chooseDataFile(p, path, link); if (t) { adopt(t); changed(); } } catch (e) { notify(`Couldn't read the data file: ${(e as Error).message}`, 'error'); } };
  const t = link.tables[cur];
  const data = t && tables ? tables.find((d) => same(d.name, t.name)) : undefined;
  const fields = data?.columns ?? t?.maps.map((m) => m.field) ?? [];
  return (
    <div class="dblink" aria-label={`Database link ${od.name}`}>
      <fieldset><legend>Source of Connection</legend>
        <div class="dbl-source">
          <span>Data file</span><input type="text" readOnly aria-label="Data file" value={link.source} placeholder="An Excel workbook (.xlsx) or a CSV file" />
          <button class="btn" onClick={() => void browse()}>Browse...</button>
          <button class="btn default" onClick={() => void connect()}>{tables ? 'Reconnect' : 'Connect'}</button>
          <span class={tables ? 'dbl-ok' : 'muted small'}>{tables ? `Connected: ${tables.length} table${tables.length === 1 ? '' : 's'}` : link.source ? 'Not connected' : 'Choose the data file'}</span>
        </div>
      </fieldset>
      <div class="dbl-main">
        <div class="dbl-tables">
          <div class="dbl-head">Tables</div>
          {link.tables.map((x, i) => (
            <label key={x.name} class={`dbl-table${i === cur ? ' on' : ''}`} onMouseDown={() => setCur(i)}>
              <input type="checkbox" aria-label={`Enable ${x.name}`} checked={x.enabled} onChange={() => { x.enabled = !x.enabled; changed(); }} />{x.name}
            </label>
          ))}
          {!link.tables.length && <p class="muted small">Connect to list the tables</p>}
          <fieldset><legend>Default Actions</legend>
            <label class="do-row"><span>Update Values</span><select aria-label="Default update" value={link.defaults.update} onChange={(e) => { link.defaults.update = (e.target as HTMLSelectElement).value as 'Update'; changed(); }}><option>Update</option><option>Do not update</option></select></label>
            <label class="do-row"><span>Add To Design</span><select aria-label="Default add" value={link.defaults.add} onChange={(e) => { link.defaults.add = (e.target as HTMLSelectElement).value as 'Add'; changed(); }}><option>Add</option><option>Do not add</option><option>Add only if not blank</option></select></label>
          </fieldset>
        </div>
        <div class="dbl-right">
          <div class="out-tabs" role="tablist">
            <button role="tab" class={tab === 'map' ? 'on' : ''} onClick={() => setTab('map')}>Field Mappings</button>
            <button role="tab" class={tab === 'browse' ? 'on' : ''} onClick={() => setTab('browse')}>Table Browser</button>
          </div>
          {!t ? <p class="muted">No table chosen</p> : tab === 'map' ? <>
            <fieldset><legend>Field Matching Criteria — Single key lookup</legend>
              <div class="dbl-key">
                <span>Database field</span>
                <select aria-label="Key database field" value={t.keyField} onChange={(e) => { t.keyField = (e.target as HTMLSelectElement).value; changed(); }}>{fields.map((f) => <option key={f} value={f}>{f}</option>)}</select>
                <span>Part parameter</span>
                <input type="text" aria-label="Key part parameter" value={t.keyParameter} onInput={(e) => { t.keyParameter = (e.target as HTMLInputElement).value; changed(); }} onKeyDown={(e) => e.stopPropagation()} />
              </div>
            </fieldset>
            <Grid cols={[
              { label: 'Database Field Name', width: '180px', get: (m: FieldMap) => <span class={same(m.field, t.keyField) ? 'dbl-keyfield' : ''}>{m.field}{same(m.field, t.keyField) ? ' (key)' : ''}</span> },
              { label: 'Design Parameter', width: 'minmax(140px, 1fr)', get: (m) => <input type="text" aria-label={`Parameter for ${m.field}`} value={m.parameter} placeholder="[None]" onInput={(e) => { mapFor(t, m.field).parameter = (e.target as HTMLInputElement).value; changed(); }} onKeyDown={(e) => e.stopPropagation()} /> },
              { label: 'Update Values', width: '130px', get: (m) => <select disabled={same(m.field, t.keyField)} aria-label={`Update ${m.field}`} value={m.update} onChange={(e) => { mapFor(t, m.field).update = (e.target as HTMLSelectElement).value as UpdateMode; changed(); }}>{UPDATE_MODES.map((x) => <option key={x}>{x}</option>)}</select> },
              { label: 'Add To Design', width: '170px', get: (m) => <select disabled={same(m.field, t.keyField)} aria-label={`Add ${m.field}`} value={m.add} onChange={(e) => { mapFor(t, m.field).add = (e.target as HTMLSelectElement).value as AddMode; changed(); }}>{ADD_MODES.map((x) => <option key={x}>{x}</option>)}</select> },
              { label: 'Visible On Add', width: '90px', align: 'center', get: (m) => <input type="checkbox" aria-label={`Visible ${m.field}`} checked={m.visible} onChange={() => { const x = mapFor(t, m.field); x.visible = !x.visible; changed(); }} /> },
            ]} rows={effectiveMaps(t, fields)} empty="No fields" />
          </> : (
            data ? <Grid cols={data.columns.map((c) => ({ label: c, width: 'minmax(90px, 1fr)', get: (r: Record<string, string>) => r[c] ?? '' }))} rows={data.rows.slice(0, 500)} empty="The table is empty" />
              : <p class="muted">Connect to browse the table</p>
          )}
        </div>
      </div>
    </div>
  );
}
