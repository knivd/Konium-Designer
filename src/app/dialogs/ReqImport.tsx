/**
 * Requirements document › Import: requirements from an Excel workbook or a CSV file. Its columns
 * are matched to a requirement's fields by their headings (each can be changed), the requirements
 * it makes are shown before they are added, and they go at the end of the document (one step to
 * undo). Identifiers the project has already get the next free ones.
 */
import { useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { readXlsx } from '../../formats/xlsxRead';
import { parseCsv } from '../../formats/table';
import { FIELDS, guessColumns, importRows, type Field } from '../../model/reqIO';
import { METHODS, PRIORITIES, REQ_TYPES, VERIFY_STATES, isReq, labelOf, type Requirement } from '../../model/requirements';
import type { ReqDocument } from '../../formats/reqDoc';
import { changeReqs } from '../requirementsData';

interface Table { name: string; bytes: Uint8Array; sheets: string[]; sheet: string; header: string[]; rows: string[][] }

/** The header: the first row with two cells or more filled (else the first with any). */
function split(rows: string[][]): { header: string[]; rows: string[][] } {
  let h = rows.findIndex((r) => r.filter((c) => c.trim()).length >= 2);
  if (h < 0) h = rows.findIndex((r) => r.some((c) => c.trim()));
  if (h < 0) return { header: [], rows: [] };
  return { header: rows[h]!.map((c) => c.trim()), rows: rows.slice(h + 1).filter((r) => r.some((c) => c.trim())) };
}

export async function readTable(name: string, bytes: Uint8Array, sheet?: string): Promise<Omit<Table, 'name' | 'bytes'>> {
  if (/\.xlsx$/i.test(name)) {
    const x = await readXlsx(bytes, sheet);
    return { sheets: x.sheets, sheet: sheet ?? x.sheets[0] ?? '', ...split(x.rows) };
  }
  if (/\.xls$/i.test(name)) throw new Error('An .xls workbook isn\'t read: save it as .xlsx or CSV');
  return { sheets: [], sheet: '', ...split(parseCsv(new TextDecoder().decode(bytes))) };
}

export function ReqImportDialog({ doc, existing, onDone }: { doc: ReqDocument; existing: () => Requirement[]; onDone: (first: number) => void }) {
  const [t, setT] = useState<Table | null>(null);
  const [cols, setCols] = useState<Record<Field, number> | null>(null);
  const [err, setErr] = useState('');
  const load = async (name: string, bytes: Uint8Array, sheet?: string) => {
    setErr('');
    try {
      const x = await readTable(name, bytes, sheet);
      if (!x.header.length) throw new Error('The file has no rows');
      setT({ name, bytes, ...x });
      setCols(guessColumns(x.header));
    } catch (e) { setErr((e as Error).message); setT(null); }
  };
  const made = t && cols ? importRows(t.rows, cols, doc.reqs.prefix, existing()) : null;
  const madeReqs = made ? made.rows.filter(isReq) : [];
  const run = () => {
    if (!made) return;
    const first = doc.reqs.rows.length;
    changeReqs(doc, () => { doc.reqs.rows.push(...made.rows); });
    onDone(first);
    closeDialog();
  };
  const colName = (i: number) => (t?.header[i] || `Column ${i + 1}`);

  return (
    <Dialog title="Import Requirements" width={t ? 940 : 520} height={t ? 640 : undefined} onClose={closeDialog} class="rq-import"
      footer={<><button class="btn default" disabled={!madeReqs.length} onClick={run}>Import {madeReqs.length} Requirement{madeReqs.length === 1 ? '' : 's'}</button>
        <span class="small muted rq-dlg-state">{made && made.renamed ? `${made.renamed} identifier${made.renamed === 1 ? '' : 's'} the project has already: given new ones` : ''}</span><span class="spacer" /><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <div class="rq-dlg">
        <label class="rq-file">From<input type="file" accept=".xlsx,.csv,.tsv,.txt" aria-label="Table to import" onChange={async (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) await load(f.name, new Uint8Array(await f.arrayBuffer())); }} /></label>
        {!t && <p class="small muted">An Excel workbook (.xlsx) or a CSV file, one requirement a row, with a heading over each column: ID, Section, Title, Requirement, Type, Priority, Status, Parent, Method, Verification, Note (any of them; other names are matched too, and you can match them yourself).</p>}
        {err && <p class="small ai-error">{err}</p>}
        {t && cols && (
          <>
            {t.sheets.length > 1 && <label class="rq-file">Sheet<select aria-label="Sheet" value={t.sheet} onChange={(e) => void load(t.name, t.bytes, (e.target as HTMLSelectElement).value)}>{t.sheets.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>}
            <fieldset class="rq-map"><legend>Columns: {t.rows.length} row{t.rows.length === 1 ? '' : 's'} in {t.name}{t.sheet ? ` › ${t.sheet}` : ''}</legend>
              {FIELDS.map(([f, label]) => (
                <label key={f}>{label}<select aria-label={`Column for ${label}`} value={cols[f]} onChange={(e) => setCols({ ...cols, [f]: Number((e.target as HTMLSelectElement).value) })}>
                  <option value={-1}>Not imported</option>
                  {t.header.map((_, i) => <option key={i} value={i}>{colName(i)}</option>)}
                </select></label>
              ))}
            </fieldset>
            {cols.title < 0 && cols.text < 0 && <p class="small ai-error">Match a column to the Title or the Requirement.</p>}
            <div class="rq-preview">
              <table class="sd-table" aria-label="Requirements to import">
                <thead><tr><th>ID</th><th>Section</th><th>Title</th><th>Requirement</th><th>Type</th><th>Priority</th><th>Method</th><th>Verification</th></tr></thead>
                <tbody>{(() => { let s = ''; return (made?.rows ?? []).slice(0, 200).map((r, i) => {
                  if (r.kind === 'section') { s = r.title; return null; }
                  return <tr key={i}><td>{r.id}</td><td>{s}</td><td>{r.title}</td><td class="rq-preview-text">{r.text}</td><td>{labelOf(REQ_TYPES, r.type)}</td><td>{labelOf(PRIORITIES, r.priority)}</td><td>{labelOf(METHODS, r.verify.method)}</td><td>{labelOf(VERIFY_STATES, r.verify.state)}</td></tr>;
                }); })()}</tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
