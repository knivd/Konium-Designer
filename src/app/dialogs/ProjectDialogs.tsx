import { useMemo, useState } from 'preact/hooks';
import { Dialog, Grid } from '../Dialog';
import { closeDialog } from './index';
import { activeId, docs, markProjectDirty, notify, tick, type OpenDoc, type Project } from '../state';
import { docBaseName, reorderDocuments } from '../../formats/altium/prjpcb';
import { SR, bagOf, type SchDocument } from '../../model/sch';
import { setProps } from '../../model/schEdit';
import { docParam, docParamChange, partParamChange, partParams } from '../../model/schParams';
import type { Change } from '../../core/undo';
import { SchEditor } from '../../editors/sch/SchEditor';
import { openSheet } from '../hierarchy';
import { projectSheets, crossProbe } from '../project';
import { cmdClose } from '../actions';
import type { SheetInput } from '../../model/compile';

/** Apply changes to one sheet as one undo step, opening it (without a tab change) when closed. */
function editSheet(p: Project | null, name: string, label: string, build: (doc: SchDocument) => (Change | null)[]): boolean {
  const od = openSheet(name, p, false);
  const ed = od?.editor;
  if (!(ed instanceof SchEditor)) return false;
  const ch = build(ed.doc).filter((c): c is Change => !!c);
  if (!ch.length) return false;
  ed.undo.transact(label, (tx) => { for (const c of ch) tx.add(c); });
  ed.invalidate();
  return true;
}

/* ─── Tools › Annotation › Number Schematic Sheets ─────────────────────────────────── */

interface SheetRow { name: string; path: string; sheetNumber: string; documentNumber: string; sheetTotal: string }

/**
 * Sheet Numbering For Project: each sheet's SheetNumber, DocumentNumber and SheetTotal document
 * parameters (what =SheetNumber and the title block show). Auto Sheet Number numbers down the
 * list; Move Up / Down reorders the project's documents too.
 */
export function NumberSheetsDialog({ project }: { project: Project }) {
  const sheets = useMemo(() => projectSheets(project), [project]);
  const [rows, setRows] = useState<SheetRow[]>(() => sheets.map((s) => ({
    name: s.name, path: project.prj.documents.find((d) => docBaseName(d).toLowerCase() === s.name.toLowerCase()) ?? s.name,
    sheetNumber: docParam(s.doc, 'SheetNumber')?.value ?? '*', documentNumber: docParam(s.doc, 'DocumentNumber')?.value ?? '*', sheetTotal: docParam(s.doc, 'SheetTotal')?.value ?? '*',
  })));
  const [sel, setSel] = useState<number | null>(rows.length ? 0 : null);
  const set = (i: number, k: keyof SheetRow, v: string) => setRows(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const move = (d: -1 | 1) => {
    if (sel === null) return;
    const j = sel + d;
    if (j < 0 || j >= rows.length) return;
    const n = [...rows];
    [n[sel], n[j]] = [n[j]!, n[sel]!];
    setRows(n); setSel(j);
  };
  const ok = () => {
    let changed = 0;
    for (const r of rows) {
      const s = sheets.find((x) => x.name === r.name)!;
      const want: [string, string][] = [['SheetNumber', r.sheetNumber], ['DocumentNumber', r.documentNumber], ['SheetTotal', r.sheetTotal]];
      const cur = want.filter(([k, v]) => (docParam(s.doc, k)?.value ?? '*') !== v);
      if (!cur.length) continue;
      if (editSheet(project, r.name, 'Number schematic sheets', (doc) => cur.map(([k, v]) => docParamChange(doc, k, v)))) changed++;
    }
    if (reorderDocuments(project.prj, rows.map((r) => r.path))) markProjectDirty(project);
    closeDialog();
    tick.value++;
    notify(changed ? `Numbered ${changed} sheet${changed > 1 ? 's' : ''}` : 'Sheet numbers unchanged');
  };
  const cell = (i: number, k: 'sheetNumber' | 'documentNumber' | 'sheetTotal', label: string) => (
    <input type="text" class="cell-edit" value={rows[i]![k]} aria-label={`${rows[i]!.name} ${label}`} onInput={(e) => set(i, k, (e.target as HTMLInputElement).value)} />
  );
  return (
    <Dialog title={`Sheet Numbering For Project ${project.name}`} width={760} height={460} onClose={closeDialog} onAccept={() => { ok(); return false; }} class="numsheets"
      footer={<>
        <button class="btn" onClick={() => setRows(rows.map((r, i) => ({ ...r, sheetNumber: String(i + 1) })))}>Auto Sheet Number</button>
        <button class="btn" onClick={() => setRows(rows.map((r, i) => ({ ...r, documentNumber: String(i + 1) })))}>Auto Document Number</button>
        <button class="btn" onClick={() => setRows(rows.map((r) => ({ ...r, sheetTotal: String(rows.length) })))}>Update Sheet Count</button>
        <button class="btn" disabled={!sel} onClick={() => move(-1)}>Move Up</button>
        <button class="btn" disabled={sel === null || sel >= rows.length - 1} onClick={() => move(1)}>Move Down</button>
        <span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button>
      </>}>
      <Grid cols={[{ label: 'Document Name', get: (r: SheetRow) => r.name },
        { label: 'Sheet Number', width: '120px', get: (r) => cell(rows.indexOf(r), 'sheetNumber', 'Sheet Number') },
        { label: 'Document Number', width: '130px', get: (r) => cell(rows.indexOf(r), 'documentNumber', 'Document Number') },
        { label: 'Sheet Total', width: '110px', get: (r) => cell(rows.indexOf(r), 'sheetTotal', 'Sheet Total') }]}
        rows={rows} sel={sel} onSel={setSel} empty="The project has no schematic sheets" />
    </Dialog>
  );
}

/* ─── Project › Project Documents ────────────────────────────────────────────────────── */

export function ProjectDocumentsDialog({ project }: { project: Project }) {
  const rows = project.prj.documents;
  const [sel, setSel] = useState<number | null>(rows.length ? 0 : null);
  const open = (i: number | null) => {
    if (i === null || !rows[i]) return;
    closeDialog();
    const od = openSheet(docBaseName(rows[i]!), project, true);
    if (od) activeId.value = od.id;
  };
  const typeOf = (p: string) => (p.split('.').pop() ?? '').replace(/^schdoc$/i, 'Schematic').replace(/^pcbdoc$/i, 'PCB').replace(/^schlib$/i, 'Schematic Library')
    .replace(/^pcblib$/i, 'PCB Library').replace(/^outjob$/i, 'Output Job').replace(/^bomdoc$/i, 'BOM');
  return (
    <Dialog title={`Documents In ${project.name}`} width={620} height={420} onClose={closeDialog} onAccept={() => { open(sel); return false; }}
      footer={<><span class="muted small">{rows.length} document{rows.length === 1 ? '' : 's'}</span><span class="spacer" /><button class="btn default" disabled={sel === null} onClick={() => open(sel)}>Open</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <Grid cols={[{ label: 'Document', get: (r: string) => docBaseName(r) }, { label: 'Type', width: '140px', get: (r) => typeOf(r) },
        { label: 'Path', get: (r) => r.replace(/\//g, '\\') }, { label: 'Loaded', width: '60px', align: 'center', get: (r) => (project.files.has(docBaseName(r).toLowerCase()) ? '✓' : '') }]}
        rows={rows} sel={sel} onSel={setSel} onOpen={open} empty="The project has no documents" />
    </Dialog>
  );
}

/* ─── Project › NoERC Manager ────────────────────────────────────────────────────────── */

interface NoErcRow { sheet: string; index: number; x: number; y: number; active: boolean; all: boolean; what: string }

function noErcRows(sheets: SheetInput[]): NoErcRow[] {
  const out: NoErcRow[] = [];
  for (const s of sheets) {
    for (const o of s.doc.objects) {
      if (o.kind !== 'noerc') continue;
      const b = bagOf(s.doc, o);
      const modern = !!b && (b.has('SUPPRESSALL') || b.has('ISACTIVE'));
      const all = !b || b.bool('SUPPRESSALL') || (!b.has('SUPPRESSALL') && !b.has('ERRORKINDSETTOSUPPRESS') && !b.has('CONNECTIONPAIRSTOSUPPRESS'));
      const kinds = [...(b?.get('ERRORKINDSETTOSUPPRESS') ?? '').matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
      const pairs = b?.get('CONNECTIONPAIRSTOSUPPRESS') ?? '';
      out.push({ sheet: s.name, index: o.index, x: Math.round(o.at.x / 100_000), y: Math.round(o.at.y / 100_000), active: !modern || !!b?.bool('ISACTIVE'), all,
        what: all ? 'All violations' : [...kinds, ...(pairs ? [`Connection pairs ${pairs}`] : [])].join('; ') });
    }
  }
  return out;
}

export function NoErcManagerDialog({ project, sheets: given }: { project: Project | null; sheets?: SheetInput[] }) {
  const sheets = given ?? projectSheets(project);
  const [rows, setRows] = useState(() => noErcRows(sheets));
  const [sel, setSel] = useState<number | null>(rows.length ? 0 : null);
  const ok = () => {
    const before = noErcRows(sheets);
    const bySheet = new Map<string, NoErcRow[]>();
    for (const r of rows) {
      const b = before.find((x) => x.sheet === r.sheet && x.index === r.index);
      if (b && b.active !== r.active) bySheet.set(r.sheet, [...(bySheet.get(r.sheet) ?? []), r]);
    }
    for (const [sheet, list] of bySheet) editSheet(project, sheet, 'NoERC Manager', (doc) => list.map((r) => setProps(doc, r.index, { ISACTIVE: r.active ? 'T' : null })));
    closeDialog();
    if (bySheet.size) notify(`Updated No ERC markers on ${bySheet.size} sheet${bySheet.size > 1 ? 's' : ''}`);
  };
  return (
    <Dialog title="NoERC Manager" width={780} height={460} onClose={closeDialog} onAccept={() => { ok(); return false; }}
      footer={<>
        <button class="btn" disabled={!rows.length} onClick={() => setRows(rows.map((r) => ({ ...r, active: true })))}>All On</button>
        <button class="btn" disabled={!rows.length} onClick={() => setRows(rows.map((r) => ({ ...r, active: false })))}>All Off</button>
        <span class="muted small">{rows.length} marker{rows.length === 1 ? '' : 's'}</span>
        <span class="spacer" /><button class="btn default" onClick={ok}>OK</button><button class="btn" onClick={closeDialog}>Cancel</button>
      </>}>
      <Grid cols={[
        { label: 'Active', width: '54px', align: 'center', get: (r: NoErcRow) => <input type="checkbox" checked={r.active} aria-label={`No ERC ${r.x},${r.y} active`} onChange={(e) => setRows(rows.map((x) => (x === r ? { ...x, active: (e.target as HTMLInputElement).checked } : x)))} /> },
        { label: 'Document', width: '160px', get: (r) => r.sheet }, { label: 'Location', width: '110px', get: (r) => `${r.x}, ${r.y}` },
        { label: 'Suppressed', get: (r) => r.what }]}
        rows={rows} sel={sel} onSel={setSel} onOpen={(i) => { const r = rows[i]; if (r) { closeDialog(); crossProbe([{ sheet: r.sheet, index: r.index }], project); } }}
        empty="No No ERC markers in the project" />
    </Dialog>
  );
}

/* ─── Window › More Windows ──────────────────────────────────────────────────────────── */

export function MoreWindowsDialog() {
  const list = docs.value;
  const [sel, setSel] = useState<number | null>(list.findIndex((d) => d.id === activeId.value));
  const go = (i: number | null) => { const d = i === null ? undefined : list[i]; if (!d) return; closeDialog(); activeId.value = d.id; };
  return (
    <Dialog title="Select Window" width={520} height={380} onClose={closeDialog} onAccept={() => { go(sel); return false; }}
      footer={<>
        <button class="btn" disabled={sel === null || !list[sel]} onClick={() => { const d = sel === null ? undefined : list[sel]; if (d) { closeDialog(); cmdClose(d); } }}>Close Window</button>
        <span class="spacer" /><button class="btn default" disabled={sel === null} onClick={() => go(sel)}>Activate</button><button class="btn" onClick={closeDialog}>Cancel</button>
      </>}>
      <Grid cols={[{ label: 'Document', get: (d: OpenDoc) => `${d.name}${d.editor?.undo.dirty ? ' *' : ''}` }, { label: 'State', width: '80px', get: (d) => (d.hidden ? 'Hidden' : 'Open') }]}
        rows={list} sel={sel} onSel={setSel} onOpen={go} />
    </Dialog>
  );
}

/* ─── Tools › Parameter Manager ──────────────────────────────────────────────────────── */

interface PmRow { sheet: string; part: number | null; label: string; values: Map<string, string> }

/**
 * Parameter Table Editor: one row per part (and one per sheet for the document's own
 * parameters), one column per parameter name. Edited cells show bold; Accept Changes writes
 * them (one undo step per sheet). A cell for a parameter the object lacks adds it, hidden.
 */
export function ParameterManagerDialog({ project, sheets: given, library, edit = (sheet, label, build) => editSheet(project, sheet, label, build) }: {
  project: Project | null; sheets?: SheetInput[];
  /** A schematic library's Parameter Manager: a row per component (by library reference), no documents. */
  library?: string;
  edit?: (sheet: string, label: string, build: (doc: SchDocument) => (Change | null)[]) => boolean;
}) {
  const sheets = given ?? projectSheets(project);
  const [kind, setKind] = useState<'parts' | 'documents'>('parts');
  const base = useMemo(() => {
    const rows: PmRow[] = [];
    for (const s of sheets) {
      const values = new Map<string, string>();
      for (const o of s.doc.objects) {
        if (o.record !== SR.PARAMETER || !(o.owner < 0 || s.doc.objects[o.owner]?.record === SR.SHEET)) continue;
        const b = bagOf(s.doc, o), n = b?.get('NAME');
        if (n && !values.has(n)) values.set(n, b!.get('TEXT') ?? '');
      }
      rows.push({ sheet: s.name, part: null, label: s.name, values });
      for (const p of partParams(s.doc)) rows.push({ sheet: s.name, part: p.index, label: (library ? p.libRef : p.designator) || '(none)', values: new Map([...p.params.values()].map((x) => [x.name, x.value])) });
    }
    return rows;
  }, [sheets]);
  const [edits, setEdits] = useState<Map<string, string>>(new Map());
  const [sel, setSel] = useState<number | null>(null);
  const shown = base.filter((r) => (kind === 'parts' ? r.part !== null : r.part === null));
  const names = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of shown) for (const k of r.values.keys()) if (!seen.has(k.toUpperCase())) seen.set(k.toUpperCase(), k);
    const order = ['Comment', 'Value', 'Description'];
    return [...seen.values()].sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
  }, [shown]);
  const key = (r: PmRow, n: string) => `${r.sheet}|${r.part ?? 'doc'}|${n.toUpperCase()}`;
  const valueOfBase = (r: PmRow, n: string) => [...r.values].find(([k]) => k.toUpperCase() === n.toUpperCase())?.[1];
  const valueOf = (r: PmRow, n: string) => edits.get(key(r, n)) ?? [...r.values].find(([k]) => k.toUpperCase() === n.toUpperCase())?.[1];
  const accept = () => {
    const bySheet = new Map<string, { r: PmRow; n: string; v: string }[]>();
    for (const [k, v] of edits) {
      const [sheet, part, upper] = k.split('|') as [string, string, string];
      const r = base.find((x) => x.sheet === sheet && String(x.part ?? 'doc') === part);
      if (!r) continue;
      const n = [...r.values.keys()].find((x) => x.toUpperCase() === upper) ?? names.find((x) => x.toUpperCase() === upper) ?? upper;
      if ((valueOfBase(r, n) ?? null) === v) continue;
      bySheet.set(sheet, [...(bySheet.get(sheet) ?? []), { r, n, v }]);
    }
    let count = 0;
    for (const [sheet, list] of bySheet) {
      if (edit(sheet, 'Parameter Manager', (doc) => list.map(({ r, n, v }) => (r.part === null ? docParamChange(doc, n, v) : partParamChange(doc, r.part, n, v))))) count += list.length;
    }
    closeDialog();
    tick.value++;
    notify(count ? `Changed ${count} parameter${count > 1 ? 's' : ''}` : 'No parameters changed');
  };
  const cols = [
    { label: library ? 'Component' : kind === 'parts' ? 'Designator' : 'Document', width: library ? '160px' : '110px', get: (r: PmRow) => r.label },
    ...(kind === 'parts' && !library ? [{ label: 'Document', width: '130px', get: (r: PmRow) => r.sheet }] : []),
    ...names.map((n) => ({
      label: n, width: 'minmax(110px, 1fr)', get: (r: PmRow) => {
        const v = valueOf(r, n), edited = edits.has(key(r, n));
        return <input type="text" class={`cell-edit${edited ? ' edited' : ''}${v === undefined ? ' absent' : ''}`} value={v ?? ''} placeholder={v === undefined ? '—' : ''} aria-label={`${r.label} ${n}`}
          onInput={(e) => { const m = new Map(edits); m.set(key(r, n), (e.target as HTMLInputElement).value); setEdits(m); }} />;
      },
    })),
  ];
  return (
    <Dialog title={library ? `Parameter Table Editor For Library [${library}]` : 'Parameter Table Editor For Project'} width={1000} height={600} onClose={closeDialog} class="parammgr"
      footer={<>
        {!library && <div class="dlg-tabs inline" role="tablist">
          <button role="tab" aria-selected={kind === 'parts'} onClick={() => setKind('parts')}>Parts</button>
          <button role="tab" aria-selected={kind === 'documents'} onClick={() => setKind('documents')}>Documents</button>
        </div>}
        <span class="muted small">{shown.length} objects, {names.length} parameters, {edits.size} changed</span>
        <span class="spacer" /><button class="btn default" disabled={!edits.size} onClick={accept}>Accept Changes</button><button class="btn" onClick={closeDialog}>Cancel</button>
      </>}>
      <div class="pm-wrap"><Grid cols={cols} rows={shown} sel={sel} onSel={setSel} empty="Nothing to edit" /></div>
    </Dialog>
  );
}

/* ─── Tools › Footprint Manager ──────────────────────────────────────────────────────── */

interface FpRow { sheet: string; part: number; designator: string; comment: string; models: { index: number; name: string; current: boolean }[] }

function footprintRows(sheets: SheetInput[]): FpRow[] {
  const out: FpRow[] = [];
  for (const s of sheets) {
    const doc = s.doc;
    for (const p of partParams(doc)) {
      const models: FpRow['models'] = [];
      for (const list of doc.objects.filter((c) => c.owner === p.index && c.record === SR.IMPLEMENTATION_LIST)) {
        for (const impl of doc.objects.filter((c) => c.owner === list.index && c.record === SR.IMPLEMENTATION)) {
          const b = bagOf(doc, impl);
          if (b?.get('MODELTYPE')?.toUpperCase() === 'PCBLIB') models.push({ index: impl.index, name: b.get('MODELNAME') ?? '', current: b.bool('ISCURRENT') });
        }
      }
      out.push({ sheet: s.name, part: p.index, designator: p.designator, comment: p.params.get('COMMENT')?.value ?? '', models });
    }
  }
  return out;
}

/**
 * Footprint Manager: every part with its footprints; choose which is current. Accept Changes
 * sets ISCURRENT on the chosen model (one undo step per sheet).
 */
export function FootprintManagerDialog({ project, sheets: given }: { project: Project | null; sheets?: SheetInput[] }) {
  const sheets = given ?? projectSheets(project);
  const rows = useMemo(() => footprintRows(sheets), [sheets]);
  const [choice, setChoice] = useState<Map<string, number>>(new Map());
  const [sel, setSel] = useState<number | null>(rows.length ? 0 : null);
  const [filter, setFilter] = useState('');
  const k = (r: FpRow) => `${r.sheet}|${r.part}`;
  const current = (r: FpRow) => choice.get(k(r)) ?? r.models.find((m) => m.current)?.index ?? r.models[0]?.index;
  const shown = rows.filter((r) => !filter || `${r.designator} ${r.comment} ${r.models.map((m) => m.name).join(' ')}`.toLowerCase().includes(filter.toLowerCase()));
  const accept = () => {
    const bySheet = new Map<string, FpRow[]>();
    for (const r of rows) {
      const want = choice.get(k(r));
      if (want === undefined || want === (r.models.find((m) => m.current)?.index ?? r.models[0]?.index)) continue;
      bySheet.set(r.sheet, [...(bySheet.get(r.sheet) ?? []), r]);
    }
    for (const [sheet, list] of bySheet) {
      editSheet(project, sheet, 'Footprint Manager', (doc) => list.flatMap((r) => r.models.map((m) => {
        const on = m.index === choice.get(k(r));
        return on === m.current ? null : setProps(doc, m.index, { ISCURRENT: on ? 'T' : null });
      })));
    }
    closeDialog();
    if (bySheet.size) notify('Footprints updated');
  };
  return (
    <Dialog title="Footprint Manager" width={880} height={560} onClose={closeDialog} class="fpmgr"
      footer={<><input type="text" placeholder="Filter" aria-label="Filter parts" value={filter} onInput={(e) => setFilter((e.target as HTMLInputElement).value)} />
        <span class="muted small">{shown.length} of {rows.length} parts</span>
        <span class="spacer" /><button class="btn default" disabled={!choice.size} onClick={accept}>Accept Changes</button><button class="btn" onClick={closeDialog}>Cancel</button></>}>
      <Grid cols={[{ label: 'Designator', width: '100px', get: (r: FpRow) => r.designator }, { label: 'Comment', get: (r) => r.comment },
        { label: 'Current Footprint', width: 'minmax(180px, 1.2fr)', get: (r) => (r.models.length > 1
          ? <select value={String(current(r))} aria-label={`${r.designator} footprint`} onChange={(e) => { const m = new Map(choice); m.set(k(r), Number((e.target as HTMLSelectElement).value)); setChoice(m); }}>
            {r.models.map((m) => <option key={m.index} value={String(m.index)}>{m.name}</option>)}</select>
          : r.models[0]?.name ?? <span class="muted">(none)</span>) },
        { label: 'Footprints', width: '80px', align: 'right', get: (r) => String(r.models.length) }, { label: 'Document', width: '140px', get: (r) => r.sheet }]}
        rows={shown} sel={sel} onSel={setSel} onOpen={(i) => { const r = shown[i]; if (r) { closeDialog(); crossProbe([{ sheet: r.sheet, index: r.part }], project); } }}
        empty="No parts in the project" />
    </Dialog>
  );
}
