import { useState } from 'preact/hooks';
import { Dialog, Grid } from '../Dialog';
import { closeDialog, showDialog } from './index';
import { EcoDialog, type EcoChange } from './Eco';
import { ORDER_LABEL, planAnnotation, subPart, type AnnotateOrder, type AnnotateRow } from '../../model/annotate';
import { activeProject, crossProbe, projectSheets } from '../project';
import { docs, notify, projects } from '../state';
import { openDocument } from '../actions';
import { setProps } from '../../model/schEdit';
import type { SchDocument } from '../../model/sch';
import { annotateOrder, setAnnotateOrder, setSheetEnabled, sheetEnabled } from '../annotation';

/** Tools › Annotation › Annotate Schematics: propose designators, accept them through an ECO. */
export function AnnotateDialog() {
  const p = activeProject();
  const sheets = projectSheets(p);
  const [order, setOrder] = useState<AnnotateOrder>(annotateOrder);
  const [enabled, setEnabled] = useState<Set<string>>(() => new Set(sheets.filter((s) => sheetEnabled(p, s.name)).map((s) => s.name)));
  const [rows, setRows] = useState<AnnotateRow[] | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const chosen = sheets.filter((s) => enabled.has(s.name));
  const pending = planAnnotation(chosen, order);
  const total = chosen.reduce((n, s) => n + s.doc.objects.filter((o) => o.kind === 'component').length, 0);
  const update = (reset = false) => { setRows(planAnnotation(chosen, order, reset)); setSel(null); };
  const accept = () => {
    const list = (rows ?? []).filter((r) => r.proposed !== r.current);
    if (!list.length) { notify('No changes to accept: press Update Changes List first'); return; }
    showDialog(EcoDialog, { changes: list.map((r) => ecoFor(r, p?.id ?? null)) });
  };
  return (
    <Dialog title={`Annotate${p ? ` [${p.name}]` : ''}`} width={1060} height={620} onClose={closeDialog} class="annotate"
      footer={<>
        <span class="muted">{pending.length} of {total} parts require annotation</span>
        <span class="spacer" />
        <button class="btn" onClick={() => update(false)}>Update Changes List</button>
        <button class="btn" onClick={() => update(true)}>Reset All</button>
        <button class="btn default" onClick={accept} disabled={!rows?.some((r) => r.proposed !== r.current)}>Accept Changes (Create ECO)</button>
        <button class="btn" onClick={closeDialog}>Close</button>
      </>}>
      <div class="annotate-layout">
        <div class="annotate-config">
          <fieldset>
            <legend>Order of Processing</legend>
            <select value={order} onChange={(e) => { const o = (e.target as HTMLSelectElement).value as AnnotateOrder; setOrder(o); setAnnotateOrder(o); setRows(null); }}>
              {(Object.keys(ORDER_LABEL) as AnnotateOrder[]).map((k) => <option key={k} value={k}>{ORDER_LABEL[k]}</option>)}
            </select>
            <OrderPicture order={order} />
          </fieldset>
          <fieldset class="annotate-sheets">
            <legend>Schematic Sheets To Annotate</legend>
            <Grid
              cols={[
                { label: '', width: '24px', get: (s: { name: string }) => <input type="checkbox" checked={enabled.has(s.name)} onChange={() => { const n = new Set(enabled); const on = !n.has(s.name); if (on) n.add(s.name); else n.delete(s.name); setSheetEnabled(p, s.name, on); setEnabled(n); setRows(null); }} /> },
                { label: 'Schematic Sheet', get: (s) => s.name },
                { label: 'Annotation Scope', width: '110px', get: () => 'All' },
                { label: 'Start Index', width: '80px', align: 'right', get: () => '1' },
              ]}
              rows={sheets} empty="No schematic sheets." />
          </fieldset>
        </div>
        <fieldset class="annotate-changes">
          <legend>Proposed Change List</legend>
          <Grid
            cols={[
              { label: 'Current Designator', get: (r: AnnotateRow) => r.current || '(blank)' },
              { label: 'Sub', width: '40px', get: (r) => subPart(r) },
              { label: 'Proposed Designator', get: (r) => <span class={r.proposed !== r.current ? 'annotate-new' : ''}>{r.proposed}</span> },
              { label: 'Sub', width: '40px', get: (r) => subPart(r) },
              { label: 'Location of Part', get: (r) => r.sheet },
            ]}
            rows={rows ?? pending.map((r) => ({ ...r, proposed: r.current }))}
            sel={sel} onSel={setSel}
            onOpen={(i) => { const r = (rows ?? pending)[i]; if (r) crossProbe([{ sheet: r.sheet, index: r.componentIndex }], p); }}
            empty="All parts are annotated." />
        </fieldset>
      </div>
    </Dialog>
  );
}

function OrderPicture({ order }: { order: AnnotateOrder }) {
  // Four parts on a 2×2 grid numbered in processing order
  const pos: Record<AnnotateOrder, [number, number][]> = {
    acrossThenDown: [[0, 0], [1, 0], [0, 1], [1, 1]], acrossThenUp: [[0, 1], [1, 1], [0, 0], [1, 0]],
    downThenAcross: [[0, 0], [0, 1], [1, 0], [1, 1]], upThenAcross: [[0, 1], [0, 0], [1, 1], [1, 0]],
  };
  return (
    <svg class="order-pic" viewBox="0 0 120 80" width="160" height="106" aria-hidden="true">
      <rect x="1" y="1" width="118" height="78" fill="#fff" stroke="#9c9c9c" />
      {pos[order].map(([cx, cy], i) => (
        <g key={i} transform={`translate(${20 + cx * 56} ${12 + cy * 34})`}>
          <rect width="26" height="20" fill="#fff6c8" stroke="#8e2c20" />
          <text x="13" y="14" font-size="10" text-anchor="middle" fill="#1d3fa8">C{i + 1}</text>
        </g>
      ))}
    </svg>
  );
}

/** One ECO line: rewrite the designator text of a part in its sheet (opened if needed). */
function ecoFor(r: AnnotateRow, projectId: string | null): EcoChange {
  const docFor = () => {
    let od = docs.value.find((d) => d.name.toLowerCase() === r.sheet.toLowerCase() && (projectId === null || d.projectId === projectId));
    if (!od && projectId) {
      const p = projects.value.find((x) => x.id === projectId);
      const f = p?.files.get(r.sheet.toLowerCase());
      if (f) od = openDocument(f, projectId, false) ?? undefined;
    }
    return od;
  };
  return {
    group: 'Annotate Component', action: 'Modify', enabled: true,
    object: `${r.current || '(blank)'}${subPart(r)} -> ${r.proposed}${subPart(r)}`, doc: r.sheet,
    validate: () => (r.designatorIndex === null ? 'The part has no designator text to change' : null),
    execute: () => {
      const od = docFor();
      if (!od?.editor) throw new Error(`${r.sheet} could not be opened`);
      const doc = od.doc as SchDocument;
      const ed = od.editor;
      ed.undo.transact(`Annotate ${r.current} -> ${r.proposed}`, (tx) => tx.add(setProps(doc, r.designatorIndex!, { TEXT: r.proposed })));
    },
  };
}
