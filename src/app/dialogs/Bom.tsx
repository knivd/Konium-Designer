import { useMemo, useState } from 'preact/hooks';
import { Dialog } from '../Dialog';
import { closeDialog } from './index';
import { deliverOutputs } from './Outputs';
import { notify } from '../state';
import { bomColumns, bomCsv, bomHtml, bomTsv, buildBom, defaultBomSetup, type BomSetup } from '../../model/bom';
import { xlsx } from '../../formats/xlsx';
import { saveFileAs } from '../../platform/fs';
import type { OutputFile } from '../../formats/gerber/gerber';
import type { Project } from '../state';

/**
 * Reports › Bill of Materials: Altium's "Bill of Materials For Project" dialog. Tick a column to
 * show it, tick Group to merge parts with equal values into one line; click a heading to sort.
 * Export saves one file; OK writes it to the project's outputs folder.
 */
type Format = 'xlsx' | 'csv' | 'txt' | 'html';
const FORMATS: [Format, string][] = [
  ['xlsx', 'Microsoft Excel Worksheet (*.xlsx)'], ['csv', 'CSV (Comma Delimited) (*.csv)'],
  ['txt', 'Tab Delimited Text (*.txt)'], ['html', 'Web Page (*.htm; *.html)'],
];
const setups = new Map<string, BomSetup & { format: Format }>();

export function bomFile(title: string, base: string, format: Format, columns: string[], rows: string[][]): OutputFile {
  switch (format) {
    case 'xlsx': return { name: `${base}.xlsx`, text: '', bytes: xlsx('Bill of Materials', columns, rows) };
    case 'csv': return { name: `${base}.csv`, text: bomCsv(columns, rows) };
    case 'txt': return { name: `${base}.txt`, text: bomTsv(columns, rows) };
    case 'html': return { name: `${base}.html`, text: bomHtml(title, columns, rows) };
  }
}

export function BomDialog({ name, project, items }: { name: string; project: Project | null; items: Record<string, string>[] }) {
  const all = useMemo(() => bomColumns(items), [items]);
  const [s, setS] = useState(() => structuredClone(setups.get(name) ?? { ...defaultBomSetup(), format: 'xlsx' as Format }));
  const set = (p: Partial<typeof s>) => setS({ ...s, ...p });
  const rows = useMemo(() => buildBom(items, s), [items, s]);
  const parts = items.length;
  const base = name.replace(/\.(prjpcb|schdoc|pcbdoc)$/i, '');
  const title = `Bill of Materials For Project [${name}]`;

  const toggleShow = (c: string) => set({ columns: s.columns.includes(c) ? s.columns.filter((x) => x !== c) : [...s.columns, c].sort((a, b) => order(a) - order(b)) });
  const order = (c: string) => { const i = all.indexOf(c); return i < 0 ? 999 : i; };
  const toggleGroup = (c: string) => set({ group: s.group.includes(c) ? s.group.filter((x) => x !== c) : [...s.group, c] });
  const sortBy = (c: string) => set({ sort: { column: c, descending: s.sort?.column === c ? !s.sort.descending : false } });

  const file = () => bomFile(title, base, s.format, s.columns, rows);
  const remember = () => setups.set(name, s);
  const exportFile = async () => {
    remember();
    const f = file();
    try { await saveFileAs(f.name, f.bytes ?? new TextEncoder().encode(f.text)); notify(`Bill of Materials saved as ${f.name}`); } catch (e) { notify(`Couldn't save: ${(e as Error).message}`, 'error'); }
  };
  const ok = () => { remember(); closeDialog(); void deliverOutputs(project, name, 'Bill of Materials', [file()]); };

  return (
    <Dialog title={title} width={1000} height={620} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="bom"
      footer={<>
        <label class="bom-format">File Format
          <select value={s.format} onChange={(e) => set({ format: (e.target as HTMLSelectElement).value as Format })}>
            {FORMATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <span class="spacer" />
        <button class="btn" onClick={() => void exportFile()}>Export...</button>
        <button class="btn default" onClick={ok}>OK</button>
        <button class="btn" onClick={closeDialog}>Cancel</button>
      </>}>
      <div class="bom-body">
        <div class="bom-side">
          <fieldset><legend>Grouped Columns</legend>
            {s.group.length ? s.group.map((g) => <div key={g} class="bom-chip">{g}<button aria-label={`Ungroup ${g}`} onClick={() => toggleGroup(g)}>×</button></div>)
              : <p class="muted small">No grouping: one line per part</p>}
          </fieldset>
          <fieldset class="bom-cols"><legend>All Columns</legend>
            <div class="bom-col bom-col-head"><span>Column</span><span>Show</span><span>Group</span></div>
            {all.map((c) => (
              <div key={c} class="bom-col">
                <span title={c}>{c}</span>
                <input type="checkbox" checked={s.columns.includes(c)} onChange={() => toggleShow(c)} aria-label={`Show ${c}`} />
                <input type="checkbox" checked={s.group.includes(c)} disabled={c === 'Quantity' || c === 'Designator'} onChange={() => toggleGroup(c)} aria-label={`Group by ${c}`} />
              </div>
            ))}
          </fieldset>
        </div>
        <div class="bom-table">
          <div class="bom-scroll">
            <table>
              <thead><tr>{s.columns.map((c) => <th key={c} onClick={() => sortBy(c)} class={s.sort?.column === c ? 'sorted' : ''}>{c}{s.sort?.column === c ? (s.sort.descending ? ' ▾' : ' ▴') : ''}</th>)}</tr></thead>
              <tbody>{rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{v}</td>)}</tr>)}</tbody>
            </table>
          </div>
          <p class="muted small">{rows.length} line{rows.length === 1 ? '' : 's'}, {parts} part{parts === 1 ? '' : 's'}</p>
        </div>
      </div>
    </Dialog>
  );
}

