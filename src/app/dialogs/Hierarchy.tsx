import { useState } from 'preact/hooks';
import { Dialog, Grid } from '../Dialog';
import { closeDialog } from './index';
import { docs, markProjectDirty, notify, tick, type Project } from '../state';
import type { SchEditor } from '../../editors/sch/SchEditor';
import { docBaseName, renameDocument as prjRenameDocument } from '../../formats/altium/prjpcb';
import { readSchDoc, writeSchDoc } from '../../formats/altium/schdoc';
import { saveFileAs } from '../../platform/fs';
import { SR } from '../../model/sch';
import { removeObjects, setProps } from '../../model/schEdit';
import { PORT_IO } from '../../model/schPlace';
import { baseName, childText, entriesOf, isSymbol, portsOf, resolveSheet, sheetHierarchy, symbolNames } from '../../model/schHierarchy';
import { addEntries, addPorts, odOf, openSheet, sheetPorts, sheetsAround } from '../hierarchy';
import { addSheet } from '../actions';
import { deliverOutputs } from './Outputs';

/* ─── Choose Document to Place (Create Sheet Symbol From Sheet) ─────────────────────── */

export function ChooseSheetDialog({ sheets, onOk }: { sheets: string[]; onOk: (name: string) => void }) {
  const [sel, setSel] = useState(0);
  const ok = (i = sel) => { const n = sheets[i]; closeDialog(); if (n) onOk(n); };
  return (
    <Dialog title="Choose Document to Place" width={420} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="choosesheet"
      footer={<><span class="spacer" /><button class="btn default" onClick={() => ok()}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <Grid cols={[{ label: 'File Name', get: (n: string) => n }, { label: 'Type', width: '80px', get: () => 'SCH' }]} rows={sheets} sel={sel} onSel={setSel} onOpen={ok} />
    </Dialog>
  );
}

/* ─── Rename Child Sheet ────────────────────────────────────────────────────────────── */

type RenameMode = 'all' | 'this' | 'copy';

/** Rename a project document: its tab, the project's list and the file it will be saved as. */
function renameDocument(p: Project | null, old: string, nu: string): void {
  const k = old.toLowerCase();
  const swap = (path: string) => path.replace(/[^/\\]*$/, nu);
  const od = docs.value.find((d) => d.name.toLowerCase() === k && (p ? d.projectId === p.id : !d.projectId));
  if (od) {
    od.name = nu;
    (od.doc as { name: string }).name = nu;
    od.handle = undefined;
    if (od.path) od.path = swap(od.path);
    od.editor?.undo.markUnsaved();
  }
  if (p) {
    const f = p.files.get(k);
    if (f) { p.files.delete(k); p.files.set(nu.toLowerCase(), { ...f, name: nu, handle: undefined, path: f.path ? swap(f.path) : undefined }); }
    // The project file's [DocumentN] entry follows (and the project needs saving)
    for (const d of [...p.prj.documents]) if (docBaseName(d).toLowerCase() === k) prjRenameDocument(p.prj, d, swap(d));
    markProjectDirty(p);
  }
  docs.value = [...docs.value];
}

export function RenameChildDialog({ ed, sym }: { ed: SchEditor; sym: number }) {
  const n = symbolNames(ed.doc, sym);
  const [name, setName] = useState(n.fileName);
  const [mode, setMode] = useState<RenameMode>('all');
  const ok = () => {
    const od = odOf(ed);
    const { p, sheets } = sheetsAround(od);
    let nu = baseName(name.trim());
    if (!nu) return;
    if (!/\.[^.]+$/.test(nu)) nu += '.SchDoc';
    const old = resolveSheet(sheets.map((s) => s.name), n.fileName);
    if (old && old.toLowerCase() === nu.toLowerCase() && old === nu) { closeDialog(); return; }
    if (sheets.some((s) => s.name.toLowerCase() === nu.toLowerCase() && s.name !== old)) { notify(`${nu} is already in the project`, 'error'); return; }
    closeDialog();
    const retext = (e: SchEditor, index: number) => {
      const t = childText(e.doc, index, SR.FILE_NAME);
      if (t) e.undo.transact('Rename child sheet', (tx) => tx.add(setProps(e.doc, t.index, { TEXT: nu })));
    };
    if (mode === 'copy' && old) {
      const src = sheets.find((s) => s.name === old)!.doc;
      addSheet(readSchDoc(writeSchDoc(src), nu), p, false);
      retext(ed, sym);
      notify(`Copied ${old} to ${nu}`);
      return;
    }
    if (old) renameDocument(p, old, nu);
    if (mode === 'all' && old) {
      // Every symbol in the project that stood for the old sheet now stands for the new one
      for (const s of sheets) {
        for (const o of s.doc.objects) {
          if (!isSymbol(o) || resolveSheet([old], symbolNames(s.doc, o.index).fileName) !== old) continue;
          const e = s.doc === ed.doc ? ed : (openSheet(s.name, p, false)?.editor as SchEditor | undefined);
          if (e) retext(e, o.index);
        }
      }
    } else retext(ed, sym);
    tick.value++;
    notify(old ? `Renamed ${old} to ${nu}` : `File Name set to ${nu}`);
  };
  const radio = (v: RenameMode, label: string) => <label class="rc-opt"><input type="radio" name="rc-mode" checked={mode === v} onChange={() => setMode(v)} />{label}</label>;
  return (
    <Dialog title="Rename Child Sheet" width={520} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="renamechild"
      footer={<><span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <label class="rc-name">New child sheet file name
        <input type="text" value={name} autofocus onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      </label>
      <fieldset><legend>Options</legend>
        {radio('all', 'Rename the child document and update all relevant sheet symbols in the same project')}
        {radio('this', 'Rename the child document and update only this sheet symbol')}
        {radio('copy', 'Copy the child document and update only this sheet symbol')}
      </fieldset>
    </Dialog>
  );
}

/* ─── Synchronize Sheet Entries and Ports ───────────────────────────────────────────── */

type Item = { name: string; io: number };
const ioName = (i: number) => PORT_IO[i] ?? 'Unspecified';

export function SyncEntriesDialog({ ed, sym }: { ed: SchEditor; sym?: number }) {
  const [, setN] = useState(0);
  const bump = () => setN((n) => n + 1);
  const symbols = ed.doc.objects.filter(isSymbol);
  const [cur, setCur] = useState<number | undefined>(sym ?? symbols[0]?.index);
  const [selE, setSelE] = useState<Set<string>>(new Set());
  const [selP, setSelP] = useState<Set<string>>(new Set());
  const od = odOf(ed);
  const { p, sheets } = sheetsAround(od);
  const h = sheetHierarchy(sheets);
  const self = sheets.find((s) => s.doc === ed.doc)?.name ?? od?.name ?? '';

  const state = (index: number) => {
    const child = h.childOf.get(`${self}:${index}`);
    const cdoc = child ? sheets.find((s) => s.name === child)?.doc : undefined;
    const es = new Map<string, number>();
    for (const e of entriesOf(ed.doc, index)) if (!es.has(e.name)) es.set(e.name, e.io);
    const ps = new Map(cdoc ? sheetPorts(cdoc).map((x) => [x.name, x.io] as [string, number]) : []);
    return {
      child, cdoc,
      entries: [...es].filter(([k]) => !ps.has(k)).map(([name, io]) => ({ name, io })),
      ports: [...ps].filter(([k]) => !es.has(k)).map(([name, io]) => ({ name, io })),
      matched: [...es].filter(([k]) => ps.has(k)).map(([name, io]) => ({ name, io, portIo: ps.get(name)! })),
    };
  };
  const st = cur !== undefined && isSymbol(ed.doc.objects[cur]) ? state(cur) : null;
  const picked = (list: Item[], sel: Set<string>) => (sel.size ? list.filter((x) => sel.has(x.name)) : list);
  const childEd = (): SchEditor | null => (st?.child ? (openSheet(st.child, p, false)?.editor as SchEditor | undefined) ?? null : null);

  const addPortsFor = () => {
    const ce = childEd();
    if (!ce || !st) { notify('The sheet symbol has no child sheet: Create Sheet From Sheet Symbol first', 'error'); return; }
    addPorts(ce, picked(st.entries, selE)); setSelE(new Set()); bump();
  };
  const removeEntries = () => {
    if (!st || cur === undefined) return;
    const names = new Set(picked(st.entries, selE).map((x) => x.name));
    const idx = entriesOf(ed.doc, cur).filter((e) => names.has(e.name)).map((e) => e.index);
    if (idx.length) ed.undo.transact(`Remove ${idx.length} sheet entr${idx.length === 1 ? 'y' : 'ies'}`, (tx) => tx.add(removeObjects(ed.doc, idx)));
    setSelE(new Set()); bump();
  };
  const addEntriesFor = () => { if (!st || cur === undefined) return; addEntries(ed, cur, picked(st.ports, selP)); setSelP(new Set()); bump(); };
  const removePorts = () => {
    const ce = childEd();
    if (!ce || !st) return;
    const names = new Set(picked(st.ports, selP).map((x) => x.name));
    const idx = portsOf(ce.doc).filter((q) => names.has(q.name)).map((q) => q.index);
    if (idx.length) ce.undo.transact(`Remove ${idx.length} port${idx.length === 1 ? '' : 's'}`, (tx) => tx.add(removeObjects(ce.doc, idx)));
    setSelP(new Set()); bump();
  };

  const list = (items: Item[], sel: Set<string>, setSel: (s: Set<string>) => void, label: string) => (
    <div class="sync-list" role="listbox" aria-label={label} aria-multiselectable="true">
      {!items.length && <p class="grid-empty">None</p>}
      {items.map((x) => (
        <label key={x.name} class={`sync-row${sel.has(x.name) ? ' on' : ''}`}>
          <input type="checkbox" checked={sel.has(x.name)} onChange={() => { const n = new Set(sel); if (n.has(x.name)) n.delete(x.name); else n.add(x.name); setSel(n); }} />
          <span class="sync-name">{x.name}</span><span class="muted">{ioName(x.io)}</span>
        </label>
      ))}
    </div>
  );
  const mismatches = (i: number) => { const s = state(i); return s.entries.length + s.ports.length + s.matched.filter((m) => m.io !== m.portIo).length; };

  return (
    <Dialog title={`Synchronise Ports to Sheet Entries In ${p?.name ?? self}`} width={760} height={560} onClose={closeDialog} class="syncentries"
      footer={<><span class="spacer" /><button class="btn default" onClick={closeDialog}>Close</button></>}>
      <div class="sync-body">
        <div class="sync-symbols">
          <Grid cols={[{ label: 'Sheet Symbol', get: (o: (typeof symbols)[number]) => symbolNames(ed.doc, o.index).designator || '(none)' },
            { label: 'Child Sheet', get: (o) => h.childOf.get(`${self}:${o.index}`) ?? `${symbolNames(ed.doc, o.index).fileName} (missing)` },
            { label: 'Unmatched', width: '74px', align: 'right', get: (o) => String(mismatches(o.index)) }]}
            rows={symbols} sel={symbols.findIndex((o) => o.index === cur)} onSel={(i) => { setCur(symbols[i]?.index); setSelE(new Set()); setSelP(new Set()); }}
            empty="No sheet symbols on this sheet" />
        </div>
        {st && (
          <div class="sync-pair">
            <fieldset><legend>Unmatched Sheet Entries</legend>
              {list(st.entries, selE, setSelE, 'Unmatched Sheet Entries')}
              <div class="sync-buttons">
                <button class="btn" disabled={!st.entries.length || !st.child} onClick={addPortsFor}>Add Ports</button>
                <button class="btn" disabled={!st.entries.length} onClick={removeEntries}>Remove Sheet Entries</button>
              </div>
            </fieldset>
            <fieldset><legend>Unmatched Ports{st.child ? ` (${st.child})` : ''}</legend>
              {list(st.ports, selP, setSelP, 'Unmatched Ports')}
              <div class="sync-buttons">
                <button class="btn" disabled={!st.ports.length} onClick={addEntriesFor}>Add Sheet Entries</button>
                <button class="btn" disabled={!st.ports.length} onClick={removePorts}>Remove Ports</button>
              </div>
            </fieldset>
            <fieldset class="sync-matched"><legend>Matched Sheet Entries and Ports</legend>
              <Grid cols={[{ label: 'Name', get: (m: (typeof st.matched)[number]) => m.name }, { label: 'Sheet Entry I/O', get: (m) => ioName(m.io) },
                { label: 'Port I/O', get: (m) => <span class={m.io !== m.portIo ? 'error-text' : ''}>{ioName(m.portIo)}</span> }]}
                rows={st.matched} empty="None" />
            </fieldset>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/* ─── Text reports (Report Project Hierarchy) ───────────────────────────────────────── */

export function ReportDialog({ title, name, text, project }: { title: string; name: string; text: string; project: Project | null }) {
  const save = async () => {
    if (project?.dir) await deliverOutputs(project, name, title, [{ name, text }]);
    else { const h = await saveFileAs(name, new TextEncoder().encode(text)); if (h) notify(`Saved ${name}`); }
  };
  return (
    <Dialog title={`${title} — ${name}`} width={720} height={520} onClose={closeDialog} class="report"
      footer={<><button class="btn" onClick={() => void save()}>Save...</button><span class="spacer" /><button class="btn default" onClick={closeDialog}>Close</button></>}>
      <pre class="report-text">{text}</pre>
    </Dialog>
  );
}
