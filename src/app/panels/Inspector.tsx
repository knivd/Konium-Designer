import { schUnitsOf } from '../newSheet';
import { useEffect, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { readLocal, writeLocal } from '../../core/storage';
import { active, activeScope, docs, tick, units } from '../state';
import { ColourIcon, docIcon } from '../icons';
import { openMenuAt } from '../MenuBar';
import { showDialog } from '../dialogs';
import { ColourDialog, FontDialog } from '../dialogs/Pickers';
import { panelTitle } from '../dock/panels';
import { SchEditor } from '../../editors/sch/SchEditor';
import { PcbEditor } from '../../editors/pcb/PcbEditor';
import { SELECTION_KINDS, selectAllKinds, selectionOff, setSelects } from '../../editors/pcb/selectionFilter';
import type { Editor, PropRow, PropSection } from '../../editors/Editor';
import { CATEGORIES, MIXED, fontOf, objectKind, schProps, type FontSpec, type InspCat, type PropType, type SchCtx, type SchProp } from '../../model/schProps';
import type { AccelNode } from '../../core/keymap';
import { LinkedReqs } from './RequirementsPanel';

/**
 * SCH Inspector (PCB Inspector for boards): every property of the selected objects, grouped as
 * Altium groups them — Kind, Design, Graphical, Object Specific. With several objects selected
 * only the properties they share are listed; a value that differs shows <...>, and whatever is
 * typed goes to all of them as one undo step. "Include all types of objects / only … objects"
 * narrows a mixed selection to one kind; "from current document / all open documents" takes in
 * the selections of every open schematic.
 */

const includeKind = signal<string | null>(null);
const allDocs = signal(false);
const closedCats = signal<Set<string>>(new Set());
const selRow = signal<string | null>(null);
const COLW_KEY = 'inspector.col';
const colW = signal<number>((() => { return Number(readLocal(COLW_KEY)) || 0.48; })());

export interface Target { ed: SchEditor; x: SchCtx; kind: string }

/** The objects the Inspector (and the List, with all = every object) works on. */
export function inspectTargets(all: boolean): Target[] {
  const ed = active.value?.editor;
  const eds: SchEditor[] = all ? docs.value.map((d) => d.editor).filter((e): e is SchEditor => e instanceof SchEditor)
    : ed instanceof SchEditor ? [ed] : [];
  const out: Target[] = [];
  for (const e of eds) {
    const name = docs.value.find((d) => d.editor === e)?.name ?? e.doc.name;
    for (const i of e.selectedIndices()) {
      const o = e.doc.objects[i];
      if (!o || o.kind === 'meta') continue;
      out.push({ ed: e, x: { doc: e.doc, index: i, units: schUnitsOf(e, units.value), docName: name, libraryMode: e.libraryMode }, kind: objectKind(e.doc, o) });
    }
  }
  return out;
}

export interface MergedRow { cat: InspCat; name: string; type: PropType; options?: readonly string[]; value: string; mixed: boolean; editable: boolean; props: SchProp[]; targets: Target[]; link?: () => void }

/** The properties several objects share, with their common value (or <...>). */
export function mergeRows(ts: Target[]): MergedRow[] {
  if (!ts.length) return [];
  const lists = ts.map((t) => schProps(t.x.doc, t.x.doc.objects[t.x.index]!, t.x.libraryMode));
  const rows: MergedRow[] = [];
  for (const p of lists[0]!) {
    const ps = lists.map((l) => l.find((q) => q.cat === p.cat && q.name === p.name));
    if (ps.some((q) => !q)) continue;
    const props = ps as SchProp[];
    const vals = props.map((q, i) => q.get(ts[i]!.x));
    const mixed = vals.some((v) => v !== vals[0]);
    const link = ts.length === 1 && p.link ? (() => { const i = p.link!(ts[0]!.x); return i === undefined ? undefined : () => { ts[0]!.ed.select([`o${i}`]); tick.value++; }; })() : undefined;
    const options = p.optionsFor ? p.optionsFor(ts[0]!.x) : p.options;
    const editable = props.every((q) => !!q.set) && !(p.optionsFor && options!.length < 2);
    rows.push({ cat: p.cat, name: p.name, type: p.type, options, value: mixed ? MIXED : vals[0]!, mixed, editable, props, targets: ts, link });
  }
  return rows;
}

/** Set a property on every target: one undo step per document. */
export function applyRow(row: Pick<MergedRow, 'name' | 'props' | 'targets'>, v: string): void {
  const byEd = new Map<SchEditor, number[]>();
  row.targets.forEach((t, i) => { const l = byEd.get(t.ed) ?? []; l.push(i); byEd.set(t.ed, l); });
  for (const [ed, idx] of byEd) {
    ed.undo.transact(`Change ${row.name}`, (tx) => { for (const i of idx) { const c = row.props[i]!.set?.(row.targets[i]!.x, v); if (c) tx.add(c); } });
    ed.invalidate();
  }
  tick.value++;
}

/* ─── Value cells ───────────────────────────────────────────────────────────────────── */

export function ValueCell({ row, onCommit }: { row: { type: PropType; value: string; mixed: boolean; editable: boolean; options?: readonly string[]; fontOf?: () => FontSpec }; onCommit: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => { if (editing) { ref.current?.focus(); ref.current?.select?.(); } }, [editing]);
  const ro = !row.editable;
  switch (row.type) {
    case 'bool':
      return <input type="checkbox" class="insp-check" checked={row.value === 'true'} ref={(el) => { if (el) el.indeterminate = row.mixed; }} disabled={ro}
        onChange={(e) => onCommit(String((e.target as HTMLInputElement).checked))} />;
    case 'enum':
      if (ro) return <span class="insp-ro">{row.value}</span>;
      return (
        <select class="insp-select" value={row.mixed ? '' : row.value} onChange={(e) => onCommit((e.target as HTMLSelectElement).value)} onKeyDown={(e) => e.stopPropagation()}>
          {row.mixed && <option value="" disabled>{MIXED}</option>}
          {(row.options ?? (row.value ? [row.value] : [])).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    case 'colour':
      return (
        <button class="insp-colour" disabled={ro} title={row.mixed ? 'Several colours' : row.value} onClick={() => showDialog(ColourDialog, { value: row.mixed ? '#000000' : row.value, onOk: onCommit })}>
          <span class="swatch" style={{ background: row.mixed ? 'repeating-linear-gradient(45deg,#ccc 0 3px,#fff 3px 6px)' : row.value }} />
        </button>
      );
    case 'font':
      return (
        <span class="insp-font">
          <span>{row.value}</span>
          {!ro && <button class="insp-more" title="Change font" onClick={() => showDialog(FontDialog, { value: row.fontOf?.(), onOk: (f: FontSpec) => onCommit(JSON.stringify(f)) })}>…</button>}
        </span>
      );
    default: {
      if (ro) return <span class="insp-ro">{row.value}</span>;
      if (!editing) return <span class={`insp-val${row.mixed ? ' mixed' : ''}`} tabIndex={0} onClick={() => setEditing(true)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); e.stopPropagation(); setEditing(true); } }}>{row.type === 'multiline' ? row.value.replace(/\n/g, ' ⏎ ') : row.value}</span>;
      const done = (commit: boolean, v?: string) => { setEditing(false); if (commit && v !== undefined && v !== (row.mixed ? MIXED : row.value)) onCommit(v); };
      if (row.type === 'multiline') {
        return <textarea ref={ref} class="insp-edit" rows={4} defaultValue={row.mixed ? '' : row.value}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') done(false); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) done(true, (e.target as HTMLTextAreaElement).value); }}
          onBlur={(e) => done(true, (e.target as HTMLTextAreaElement).value)} />;
      }
      return <input ref={ref} class="insp-edit" defaultValue={row.mixed ? '' : row.value}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') { e.preventDefault(); done(false); } if (e.key === 'Enter') { e.preventDefault(); done(true, (e.target as HTMLInputElement).value); } }}
        onBlur={(e) => done(true, (e.target as HTMLInputElement).value)} />;
    }
  }
}

/* ─── The grid ──────────────────────────────────────────────────────────────────────── */

interface GridRow { key: string; cat: string; name: string; cell: preact.ComponentChildren; link?: () => void }

function PropGrid({ rows, cats }: { rows: GridRow[]; cats: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const split = (e: PointerEvent) => {
    e.preventDefault();
    const box = ref.current!.getBoundingClientRect();
    const move = (ev: PointerEvent) => { colW.value = Math.min(0.8, Math.max(0.2, (ev.clientX - box.left) / box.width)); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); writeLocal(COLW_KEY, String(colW.value)); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const toggle = (c: string) => { const n = new Set(closedCats.value); if (n.has(c)) n.delete(c); else n.add(c); closedCats.value = n; };
  return (
    <div ref={ref} class="insp-grid" style={{ '--insp-col': `${(colW.value * 100).toFixed(1)}%` } as Record<string, string>} role="treegrid">
      <div class="insp-split" style={{ left: `calc(var(--insp-col) - 2px)` }} onPointerDown={split as unknown as (e: Event) => void} />
      {cats.map((c) => {
        const mine = rows.filter((r) => r.cat === c);
        if (!mine.length) return null;
        const open = !closedCats.value.has(c);
        return (
          <div key={c} class="insp-cat" role="rowgroup">
            <div class={`insp-cat-row${selRow.value === `cat:${c}` ? ' on' : ''}`} role="row" onMouseDown={() => { selRow.value = `cat:${c}`; }} onDblClick={() => toggle(c)}>
              <button class="insp-twisty" aria-label={open ? `Collapse ${c}` : `Expand ${c}`} onClick={() => toggle(c)}>{open ? '⊟' : '⊞'}</button>
              <span>{c}</span>
            </div>
            {open && mine.map((r) => (
              <div key={r.key} class={`insp-row${selRow.value === r.key ? ' on' : ''}`} role="row" onMouseDown={() => { selRow.value = r.key; }}>
                <span class="insp-name" role="rowheader">{r.link ? <button class="insp-link" onClick={r.link}>{r.name}</button> : r.name}</span>
                <span class="insp-value" role="gridcell">{r.cell}</span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function kindMenu(kinds: string[]): AccelNode {
  return { key: '', label: 'Include', children: [
    { key: '', label: 'all types of objects', checked: !includeKind.value, action: () => { includeKind.value = null; } },
    ...kinds.map((k): AccelNode => ({ key: '', label: `only ${k} objects`, checked: includeKind.value === k, action: () => { includeKind.value = k; } })),
  ] };
}
function docMenu(): AccelNode {
  return { key: '', label: 'From', children: [
    { key: '', label: 'current document', checked: !allDocs.value, action: () => { allDocs.value = false; } },
    { key: '', label: 'all open documents', checked: allDocs.value, action: () => { allDocs.value = true; } },
  ] };
}
const linkMenu = (menu: () => AccelNode) => (e: MouseEvent) => { e.preventDefault(); const b = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenuAt(menu(), b.left, b.bottom + 2); };

function SchInspector({ ed }: { ed: SchEditor }) {
  void tick.value; // signals skip prop-less re-renders otherwise
  const all = inspectTargets(allDocs.value);
  const kinds = [...new Set(all.map((t) => t.kind))];
  const kind = includeKind.value && kinds.includes(includeKind.value) ? includeKind.value : null;
  const ts = kind ? all.filter((t) => t.kind === kind) : all;
  const merged = mergeRows(ts);
  const docCount = new Set(ts.map((t) => t.ed)).size;
  const rows: GridRow[] = merged.map((r) => ({
    key: `${r.cat}:${r.name}`, cat: r.cat, name: r.name, link: r.link,
    cell: <ValueCell row={{ ...r, fontOf: () => fontOf(r.targets[0]!.x.doc, r.targets[0]!.x.doc.objects[r.targets[0]!.x.index]!, r.props[0]!.name === 'Font' && r.targets[0]!.kind === 'Port' ? 'TEXTFONTID' : 'FONTID') }}
      onCommit={(v) => applyRow(r, v)} />,
  }));
  const name = docs.value.find((d) => d.editor === ed)?.name ?? '';
  return (
    <section class="panel inspector" aria-label={panelTitle('inspector', activeScope.value)}>
      <div class="insp-head">
        <span class="insp-include">Include <button class="link" onMouseDown={linkMenu(() => kindMenu(kinds))}>{kind ? `only ${kind} objects` : 'all types of objects'}</button> from <button class="link" onMouseDown={linkMenu(docMenu)}>{allDocs.value ? 'all open documents' : 'current document'}</button></span>
        <span class="insp-doc" title={name}><ColourIcon name={docIcon(name)} /></span>
      </div>
      <div class="panel-body">
        {rows.length ? <PropGrid rows={rows} cats={CATEGORIES} /> : <p class="panel-empty">Select objects to inspect them.</p>}
      </div>
      <LinkedReqs />
      <footer class="insp-foot">{ts.length} object(s) are displayed in {docCount} document(s)</footer>
    </section>
  );
}

/* ─── Boards: the editor's own property sections in the same grid ───────────────────── */

function rowType(r: PropRow): PropType { return r.kind === 'bool' ? 'bool' : r.kind === 'enum' ? 'enum' : r.kind === 'multiline' ? 'multiline' : 'text'; }

/** The Selection Filter (a board, nothing selected): the kinds of object a click or a selection box takes. */
function SelectionFilter() {
  const off = selectionOff.value, all = off.size === 0;
  return (
    <div class="selfilter" role="group" aria-label="Selection Filter">
      <h4>Selection Filter</h4>
      <p>The kinds of object a click or a selection box takes. A kind that is off is passed over, and what lies under it is taken.</p>
      <div class="selfilter-kinds">
        <div class="selfilter-row"><button type="button" class={`btn selfilter-all${all ? ' on' : ''}`} aria-pressed={all} title={all ? 'Every kind is on: click to turn them all off' : 'Turn every kind on'} onClick={() => selectAllKinds(!all)}>{all ? 'All - On' : 'All - Off'}</button></div>
        {SELECTION_KINDS.map((k) => <button key={k} type="button" class={`btn${off.has(k) ? '' : ' on'}`} aria-pressed={!off.has(k)} onClick={() => setSelects(k, off.has(k))}>{k}</button>)}
      </div>
    </div>
  );
}

function SectionInspector({ ed }: { ed: Editor }) {
  void tick.value;
  const sel = ed.properties();
  const sections: PropSection[] = sel.length ? sel : ed.documentProperties();
  const cats = sections.map((s, i) => `${s.title}${sections.slice(0, i).some((t) => t.title === s.title) ? ` (${i + 1})` : ''}`);
  const rows: GridRow[] = sections.flatMap((s, i) => s.rows.map((r) => ({
    key: `${i}:${r.label}`, cat: cats[i]!, name: r.label,
    cell: <ValueCell row={{ type: rowType(r), value: r.options?.find(([k]) => k === r.value)?.[1] ?? r.value, mixed: false, editable: !!r.edit, options: r.options?.map(([, l]) => l) }}
      onCommit={(v) => { const o = r.options?.find(([, l]) => l === v); r.edit?.(o ? o[0] : v); tick.value++; }} />,
  })));
  return (
    <section class="panel inspector" aria-label={panelTitle('inspector', activeScope.value)}>
      <div class="insp-head"><span class="insp-include">Include <span class="link-like">all types of objects</span> from <span class="link-like">current document</span></span></div>
      <div class="panel-body">
        {ed instanceof PcbEditor && !sel.length && <SelectionFilter />}
        {rows.length ? <PropGrid rows={rows} cats={cats} /> : <p class="panel-empty">Select objects to inspect them.</p>}
      </div>
      <LinkedReqs />
      <footer class="insp-foot">{sel.length} object(s) are displayed in {sel.length ? 1 : 0} document(s)</footer>
    </section>
  );
}

export function InspectorPanel() {
  void tick.value;
  void units.value;
  const ed = active.value?.editor;
  if (ed instanceof SchEditor) return <SchInspector ed={ed} />;
  if (ed) return <SectionInspector ed={ed} />;
  return <section class="panel inspector" aria-label="Inspector"><p class="panel-empty">Open a schematic or PCB document.</p></section>;
}
