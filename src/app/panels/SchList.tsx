import { schUnitsOf } from '../newSheet';
import { useEffect, useRef, useState } from 'preact/hooks';
import { savedWidths } from '../columnResize';
import { signal } from '@preact/signals';
import { active, activeScope, docs, tick, units } from '../state';
import { openMenuAt } from '../MenuBar';
import { panelTitle } from '../dock/panels';
import { ValueCell, applyRow, type Target } from './Inspector';
import { SchEditor } from '../../editors/sch/SchEditor';
import { SR } from '../../model/sch';
import { fontOf, objectKind, schProps, type SchProp } from '../../model/schProps';
import type { AccelNode } from '../../core/keymap';

/**
 * SCH List (Shift+F12): the schematic's objects as a spreadsheet, one row per object and a
 * column per property. "View" picks rows to select objects; "Edit" lets you type into the
 * cells. Shows the selected, the non-masked or all objects, of the current document or every
 * open schematic, of all types or only one. Click a column heading to sort.
 */

const mode = signal<'view' | 'edit'>('view');
const which = signal<'selected' | 'nonmasked' | 'all'>('nonmasked');
const allDocs = signal(false);
const kindSel = signal<string | null>(null);
const sortBy = signal<{ col: string; dir: 1 | -1 } | null>(null);
const ROW = 20;

interface ListRow { t: Target; props: SchProp[] }

/** What a sheet lists: everything but a part's own graphics (its pins, designator and parameters do list). */
function listable(ed: SchEditor, i: number): boolean {
  const o = ed.doc.objects[i]!;
  if (o.kind === 'meta' || o.record === SR.SHEET) return false;
  const ow = o.owner >= 0 ? ed.doc.objects[o.owner] : undefined;
  if (ow?.kind === 'component' && !ed.libraryMode) return o.kind === 'pin' || o.kind === 'text';
  return true;
}

function rowsNow(): ListRow[] {
  const ed = active.value?.editor;
  const eds = allDocs.value ? docs.value.map((d) => d.editor).filter((e): e is SchEditor => e instanceof SchEditor) : ed instanceof SchEditor ? [ed] : [];
  const out: ListRow[] = [];
  for (const e of eds) {
    const name = docs.value.find((d) => d.editor === e)?.name ?? e.doc.name;
    const idx = which.value === 'selected' ? e.selectedIndices() : e.doc.objects.map((o) => o.index).filter((i) => listable(e, i) && (which.value === 'all' || e.unmasked(i)));
    for (const i of idx) {
      const o = e.doc.objects[i];
      if (!o || o.kind === 'meta') continue;
      const x = { doc: e.doc, index: i, units: schUnitsOf(e, units.value), docName: name, libraryMode: e.libraryMode };
      out.push({ t: { ed: e, x, kind: objectKind(e.doc, o) }, props: schProps(e.doc, o, e.libraryMode) });
    }
  }
  return out;
}

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const keyFor = (t: Target) => { const o = t.x.doc.objects[t.x.index]!, ow = o.owner >= 0 ? t.x.doc.objects[o.owner] : undefined; return ow?.kind === 'component' && o.kind !== 'text' && !t.ed.libraryMode ? `o${ow.index}` : `o${t.x.index}`; };

const menuAt = (menu: () => AccelNode) => (e: MouseEvent) => { e.preventDefault(); const b = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenuAt(menu(), b.left, b.bottom + 2); };
const choice = <T,>(label: string, opts: [T, string][], cur: T, set: (v: T) => void): AccelNode =>
  ({ key: '', label, children: opts.map(([v, l]): AccelNode => ({ key: '', label: l, checked: v === cur, action: () => set(v) })) });

export function SchListPanel() {
  void tick.value;
  const all = rowsNow();
  const kinds = [...new Set(all.map((r) => r.t.kind))].sort();
  const kind = kindSel.value && kinds.includes(kindSel.value) ? kindSel.value : null;
  let rows = kind ? all.filter((r) => r.t.kind === kind) : all;
  // Columns: Object Kind, then every property the listed kinds have, in Altium's order
  const cols: string[] = ['Object Kind'];
  for (const r of rows) for (const p of r.props) if (p.cat !== 'Kind' && (p.cat !== 'Design' || allDocs.value) && !cols.includes(p.name)) cols.push(p.name);
  const cell = (r: ListRow, c: string) => r.props.find((p) => p.name === c);
  const s = sortBy.value;
  if (s && cols.includes(s.col)) rows = [...rows].sort((a, b) => s.dir * natural(cell(a, s.col)?.get(a.t.x) ?? '', cell(b, s.col)?.get(b.t.x) ?? ''));
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(400);
  const body = useRef<HTMLDivElement>(null);
  // The rows drawn fill the panel as it is (not only once it has been scrolled)
  const shown = rows.length > 0;
  useEffect(() => {
    const el = body.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (el.clientHeight) setHeight(el.clientHeight); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [shown]);
  const first = Math.max(0, Math.floor(scroll / ROW) - 5), last = Math.min(rows.length, first + Math.ceil(height / ROW) + 10);
  const selKeys = new Set<string>();
  for (const r of rows) if (r.t.ed.selection.has(keyFor(r.t)) || r.t.ed.selection.has(`o${r.t.x.index}`)) selKeys.add(`${r.t.ed.doc.name}:${r.t.x.index}`);
  // Widths dragged to before (header edges) win over the defaults
  const saved = savedWidths(cols);
  const template = saved ? saved.map((w) => `${w}px`).join(' ') : cols.map((c) => (c === 'Object Kind' ? '120px' : /Text|Name|Description|Value|Library|Comment|Designator|Footprint|Reference/.test(c) ? '140px' : '96px')).join(' ');
  const pick = (r: ListRow, e: MouseEvent) => {
    const k = keyFor(r.t);
    if (e.ctrlKey || e.shiftKey) { const n = new Set(r.t.ed.selection); if (n.has(k)) n.delete(k); else n.add(k); r.t.ed.select([...n]); }
    else r.t.ed.select([k]);
    tick.value++;
  };
  const modeLabel = mode.value === 'view' ? 'View' : 'Edit';
  const whichLabel = { selected: 'selected objects', nonmasked: 'non-masked objects', all: 'all objects' }[which.value];
  return (
    <section class="panel schlist" aria-label={panelTitle('list', activeScope.value)}>
      <div class="list-head">
        <button class="link" onMouseDown={menuAt(() => choice<'view' | 'edit'>('Mode', [['view', 'View'], ['edit', 'Edit']], mode.value, (v) => { mode.value = v; }))}>{modeLabel}</button>
        <button class="link" onMouseDown={menuAt(() => choice<'selected' | 'nonmasked' | 'all'>('Show', [['selected', 'selected objects'], ['nonmasked', 'non-masked objects'], ['all', 'all objects']], which.value, (v) => { which.value = v; }))}>{whichLabel}</button>
        <span>from</span>
        <button class="link" onMouseDown={menuAt(() => choice('From', [[false, 'current document'], [true, 'all open documents']], allDocs.value, (v) => { allDocs.value = v; }))}>{allDocs.value ? 'all open documents' : 'current document'}</button>
        <span>Include</span>
        <button class="link" onMouseDown={menuAt(() => choice<string | null>('Include', [[null, 'all types of objects'], ...kinds.map((k): [string, string] => [k, `only ${k} objects`])], kind, (v) => { kindSel.value = v; }))}>{kind ? `only ${kind} objects` : 'all types of objects'}</button>
      </div>
      <div class="list-wrap" ref={body} onScroll={(e) => { const el = e.currentTarget as HTMLDivElement; setScroll(el.scrollTop); if (el.clientHeight !== height) setHeight(el.clientHeight); }}>
        <div class="list-grid" style={{ '--cols': template, height: `${(rows.length + 1) * ROW}px` } as Record<string, string>} role="grid" aria-rowcount={rows.length}>
          <div class="list-row list-headrow" role="row">
            {cols.map((c) => <button key={c} aria-sort={s?.col === c ? (s.dir > 0 ? 'ascending' : 'descending') : undefined} class={s?.col === c ? (s.dir > 0 ? 'asc' : 'desc') : ''}
              onClick={() => { sortBy.value = s?.col === c ? (s.dir > 0 ? { col: c, dir: -1 } : null) : { col: c, dir: 1 }; }}>{c}</button>)}
          </div>
          {rows.slice(first, last).map((r, k) => {
            const i = first + k;
            const on = selKeys.has(`${r.t.ed.doc.name}:${r.t.x.index}`);
            return (
              <div key={`${r.t.ed.doc.name}:${r.t.x.index}`} role="row" class={`list-row${on ? ' on' : ''}`} style={{ top: `${(i + 1) * ROW}px` }}
                onMouseDown={(e) => { if (mode.value === 'view' || (e.target as HTMLElement).closest('.list-kind')) pick(r, e as unknown as MouseEvent); }}
                onDblClick={() => { r.t.ed.select([keyFor(r.t)]); r.t.ed.jumpToSelection(2_000_000); tick.value++; }}>
                {cols.map((c) => {
                  if (c === 'Object Kind') return <span key={c} role="gridcell" class="list-kind">{r.t.kind}</span>;
                  const p = cell(r, c);
                  if (!p) return <span key={c} role="gridcell" class="list-none" />;
                  const v = p.get(r.t.x);
                  if (mode.value === 'view') return <span key={c} role="gridcell" title={v}>{p.type === 'bool' ? (v === 'true' ? '✓' : '') : p.type === 'colour' ? <span class="swatch" style={{ background: v }} /> : v}</span>;
                  return <span key={c} role="gridcell" class="list-edit">
                    <ValueCell row={{ type: p.type, value: v, mixed: false, editable: !!p.set, options: p.optionsFor ? p.optionsFor(r.t.x) : p.options, fontOf: () => fontOf(r.t.x.doc, r.t.x.doc.objects[r.t.x.index]!, r.t.kind === 'Port' ? 'TEXTFONTID' : 'FONTID') }}
                      onCommit={(nv) => applyRow({ name: p.name, props: [p], targets: [r.t] }, nv)} />
                  </span>;
                })}
              </div>
            );
          })}
        </div>
      </div>
      <footer class="insp-foot">{rows.length} Objects ({selKeys.size} Selected)</footer>
    </section>
  );
}
