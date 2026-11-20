import { useMemo, useState } from 'preact/hooks';
import { Dialog, Grid } from '../Dialog';
import { closeDialog } from './index';
import { notify, replaceMessages, tick } from '../state';
import type { SchEditor } from '../../editors/sch/SchEditor';
import type { UpdateOptions } from '../../model/schUpdate';
import { partsToUpdate, updateSheet, type PartRow } from '../libSync';
import { odOf, openSheet, sheetsAround } from '../hierarchy';

/**
 * Tools › Update From Libraries: the parts on this sheet (or every sheet of the project) and the
 * library symbol each comes from; tick the ones to update and what to take from the library —
 * symbols (graphics and pins), parameters, models. One undo step per sheet.
 */
const PARAMS: [UpdateOptions['parameters'], string][] = [['keep', 'Keep the part\'s'], ['add', 'Add new from library'], ['update', 'Update values and add new'], ['replace', 'Full replace']];
let last: UpdateOptions & { all: boolean } = { graphics: true, parameters: 'update', models: true, all: false };

export function UpdateFromLibrariesDialog({ ed }: { ed: SchEditor }) {
  const od = odOf(ed);
  const [opts, setOpts] = useState(last);
  const { p, sheets } = useMemo(() => sheetsAround(od), [od]);
  const self = sheets.find((s) => s.doc === ed.doc)?.name ?? od?.name ?? ed.doc.name;
  const rows = useMemo(() => partsToUpdate(opts.all ? sheets : [{ name: self, doc: ed.doc }]), [opts.all, sheets, self, ed.doc]);
  const key = (r: PartRow) => `${r.doc}:${r.index}`;
  const [off, setOff] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<number | null>(rows.length ? 0 : null);
  const set = (q: Partial<typeof opts>) => setOpts({ ...opts, ...q });
  const chosen = rows.filter((r) => r.found && !off.has(key(r)));

  const ok = () => {
    last = opts;
    closeDialog();
    const byDoc = new Map<string, PartRow[]>();
    for (const r of chosen) byDoc.set(r.doc, [...(byDoc.get(r.doc) ?? []), r]);
    let n = 0;
    const msgs: { doc: string; level: 'info' | 'warn'; message: string }[] = [];
    for (const [doc, list] of byDoc) {
      const target = doc === self ? ed : (openSheet(doc, p, false)?.editor as SchEditor | undefined);
      if (!target) { msgs.push({ doc, level: 'warn', message: `${doc} isn't loaded: ${list.length} part(s) not updated` }); continue; }
      const k = updateSheet(target, list, opts);
      n += k;
      for (const r of list) msgs.push({ doc, level: 'info', message: `Updated ${r.designator || '(no designator)'} from ${r.found!.lib.name} › ${r.found!.sym.libRef}` });
    }
    for (const r of rows.filter((x) => !x.found)) msgs.push({ doc: r.doc, level: 'warn', message: `${r.designator || '(no designator)'}: ${r.libRef} not found in the available libraries` });
    replaceMessages('Update From Libraries', [...msgs, { doc: self, level: 'info', message: `${n} part${n === 1 ? '' : 's'} updated` }]);
    notify(`${n} part${n === 1 ? '' : 's'} updated from libraries`);
    tick.value++;
  };

  const toggle = (r: PartRow) => { const k = key(r), s = new Set(off); if (s.has(k)) s.delete(k); else s.add(k); setOff(s); };
  return (
    <Dialog title="Update From Library" width={820} height={560} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="updatelib"
      footer={<>
        <button class="btn" onClick={() => setOff(new Set())}>All On</button>
        <button class="btn" onClick={() => setOff(new Set(rows.map(key)))}>All Off</button>
        <span class="spacer" /><span class="muted small">{chosen.length} of {rows.length} parts</span>
        <button class="btn default" onClick={ok} disabled={!chosen.length}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button>
      </>}>
      <div class="ul-opts">
        <fieldset><legend>Sheets</legend>
          <label class="al-opt"><input type="radio" name="ul-scope" checked={!opts.all} onChange={() => set({ all: false })} />This sheet ({self})</label>
          <label class="al-opt"><input type="radio" name="ul-scope" checked={opts.all} onChange={() => set({ all: true })} />{p ? `All sheets of ${p.name}` : 'All open sheets'}</label>
        </fieldset>
        <fieldset><legend>Update</legend>
          <label class="al-opt"><input type="checkbox" checked={opts.graphics} onChange={(e) => set({ graphics: (e.target as HTMLInputElement).checked })} />Symbols (graphics and pins)</label>
          <label class="al-opt"><input type="checkbox" checked={opts.models} onChange={(e) => set({ models: (e.target as HTMLInputElement).checked })} />Models (footprints)</label>
          <label class="ul-param">Parameters<select value={opts.parameters} onChange={(e) => set({ parameters: (e.target as HTMLSelectElement).value as UpdateOptions['parameters'] })}>
            {PARAMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select></label>
        </fieldset>
      </div>
      <Grid cols={[
        { label: '', width: '28px', get: (r: PartRow) => <input type="checkbox" checked={!!r.found && !off.has(key(r))} disabled={!r.found} onChange={() => toggle(r)} aria-label={`Update ${r.designator}`} /> },
        { label: 'Designator', width: '100px', get: (r) => r.designator || '—' },
        { label: 'Sheet', get: (r) => r.doc },
        { label: 'Library Reference', get: (r) => r.libRef },
        { label: 'Library', get: (r) => (r.found ? r.found.lib.name : <span class="error-text">Not found{r.library ? ` (${r.library})` : ''}</span>) },
      ]} rows={rows} sel={sel} onSel={setSel} empty="No parts on these sheets." />
    </Dialog>
  );
}
