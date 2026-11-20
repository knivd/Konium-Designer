import { useEffect, useRef, useState } from 'preact/hooks';
import { savedWidths } from '../columnResize';
import { signal } from '@preact/signals';
import { active, activeScope, notify, tick } from '../state';
import { settings } from '../../core/settings';
import { openMenuAt } from '../MenuBar';
import { panelTitle } from '../dock/panels';
import { PcbEditor } from '../../editors/pcb/PcbEditor';
import { pcbObjects, pcbProps, type PcbObj, type PcbProp } from '../../model/pcbProps';
import { queryCtx } from './PcbFilter';
import type { AccelNode } from '../../core/keymap';

/**
 * PCB List (Shift+F12 on a board or footprint): the board's objects as a spreadsheet, one row per
 * object and a column per property. "View" picks rows to select objects; "Edit" lets you type
 * into the cells (one undo step each). Shows the selected, the non-masked or all objects, of all
 * types or only one. Click a column heading to sort; double-click a row to jump to it.
 */

const mode = signal<'view' | 'edit'>('view');
const which = signal<'selected' | 'nonmasked' | 'all'>('nonmasked');
const kindSel = signal<string | null>(null);
const sortBy = signal<{ col: string; dir: 1 | -1 } | null>(null);
const ROW = 20;

interface ListRow { o: PcbObj; props: PcbProp[] }
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const menuAt = (menu: () => AccelNode) => (e: MouseEvent) => { e.preventDefault(); const b = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenuAt(menu(), b.left, b.bottom + 2); };
const choice = <T,>(label: string, opts: [T, string][], cur: T, set: (v: T) => void): AccelNode =>
  ({ key: '', label, children: opts.map(([v, l]): AccelNode => ({ key: '', label: l, checked: v === cur, action: () => set(v) })) });

export function PcbListPanel() {
  void tick.value;
  const e = active.value?.editor instanceof PcbEditor ? active.value.editor : null;
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(400);
  const body = useRef<HTMLDivElement>(null);
  // The rows drawn fill the panel as it is (not only once it has been scrolled)
  const shown = !!e;
  useEffect(() => {
    const el = body.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (el.clientHeight) setHeight(el.clientHeight); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [shown]);
  const [editing, setEditing] = useState<{ id: string; col: string } | null>(null);
  if (!e) return <section class="panel schlist"><p class="panel-empty">Open a board.</p></section>;
  const x = queryCtx(e);
  const sel = e.selection;
  const objs = pcbObjects(e.doc).filter((o) => which.value === 'all' || (which.value === 'selected' ? o.keys.some((k) => sel.has(k)) : !e.mask || o.keys.some((k) => e.mask!.has(k))));
  const all: ListRow[] = objs.map((o) => ({ o, props: pcbProps(o, x) }));
  const kinds = [...new Set(all.map((r) => r.o.kind))].sort();
  const kind = kindSel.value && kinds.includes(kindSel.value) ? kindSel.value : null;
  let rows = kind ? all.filter((r) => r.o.kind === kind) : all;
  const cols: string[] = ['Object Kind'];
  for (const r of rows) for (const p of r.props) if (p.cat !== 'Kind' && !cols.includes(p.name)) cols.push(p.name);
  const cell = (r: ListRow, c: string) => r.props.find((p) => p.name === c);
  const s = sortBy.value;
  if (s && cols.includes(s.col)) rows = [...rows].sort((a, b) => s.dir * natural(c2(a, s.col), c2(b, s.col)));
  function c2(r: ListRow, c: string) { return c === 'Object Kind' ? r.o.kind : cell(r, c)?.value ?? ''; }
  const first = Math.max(0, Math.floor(scroll / ROW) - 5), last = Math.min(rows.length, first + Math.ceil(height / ROW) + 10);
  const saved = savedWidths(cols);
  const template = saved ? saved.map((w) => `${w}px`).join(' ') : cols.map((c) => (c === 'Object Kind' ? '110px' : /Net|Designator|Footprint|String|Name|Description|Component|Layer|Library|Comment/.test(c) ? '130px' : '90px')).join(' ');
  const selected = (r: ListRow) => r.o.keys.length > 0 && r.o.keys.every((k) => sel.has(k));
  const pick = (r: ListRow, ev: MouseEvent) => {
    if (ev.ctrlKey || ev.shiftKey) { const n = new Set(sel); const on = selected(r); for (const k of r.o.keys) { if (on) n.delete(k); else n.add(k); } e.select([...n]); }
    else e.select(r.o.keys);
    tick.value++;
  };
  const commit = (r: ListRow, p: PcbProp, v: string) => {
    setEditing(null);
    if (!p.set) return;
    // A cell of a selected row: every selected row that has the property takes it (a global edit),
    // asked first if Preferences › PCB Editor › General › Confirm Global Edit says so
    const targets = (selected(r) ? rows.filter(selected) : [r]).map((x) => ({ r: x, p: x === r ? p : x.props.find((q) => q.name === p.name && !!q.set) }))
      .filter((t): t is { r: ListRow; p: PcbProp } => !!t.p && t.p.value !== v);
    if (!targets.length) return;
    const go = () => {
      const changes = targets.map((t) => t.p.set!(v));
      if (changes.some((c) => !c)) { notify(`${p.name}: "${v}" isn't a value it takes`, 'error'); return; }
      e.undo.transact(targets.length > 1 ? `${p.name} of ${targets.length} objects` : `${p.name} of ${r.o.kind}`, (tx) => { for (const c of changes) tx.add(c!); });
      e.invalidate();
      tick.value++;
    };
    if (targets.length > 1 && settings.pcbConfirmGlobalEdit) e.confirm(`Change ${p.name} to "${v}" on ${targets.length} objects?`, go);
    else go();
  };
  const whichLabel = { selected: 'selected objects', nonmasked: 'non-masked objects', all: 'all objects' }[which.value];
  return (
    <section class="panel schlist pcblist" aria-label={panelTitle('list', activeScope.value)}>
      <div class="list-head">
        <button class="link" onMouseDown={menuAt(() => choice<'view' | 'edit'>('Mode', [['view', 'View'], ['edit', 'Edit']], mode.value, (v) => { mode.value = v; }))}>{mode.value === 'view' ? 'View' : 'Edit'}</button>
        <button class="link" onMouseDown={menuAt(() => choice<'selected' | 'nonmasked' | 'all'>('Show', [['selected', 'selected objects'], ['nonmasked', 'non-masked objects'], ['all', 'all objects']], which.value, (v) => { which.value = v; }))}>{whichLabel}</button>
        <span>from current document</span>
        <span>Include</span>
        <button class="link" onMouseDown={menuAt(() => choice<string | null>('Include', [[null, 'all types of objects'], ...kinds.map((k): [string, string] => [k, `only ${k} objects`])], kind, (v) => { kindSel.value = v; }))}>{kind ? `only ${kind} objects` : 'all types of objects'}</button>
      </div>
      <div class="list-wrap" ref={body} onScroll={(ev) => { const el = ev.currentTarget as HTMLDivElement; setScroll(el.scrollTop); if (el.clientHeight !== height) setHeight(el.clientHeight); }}>
        <div class="list-grid" style={{ '--cols': template, height: `${(rows.length + 1) * ROW}px` } as Record<string, string>} role="grid" aria-rowcount={rows.length}>
          <div class="list-row list-headrow" role="row">
            {cols.map((c) => <button key={c} aria-sort={s?.col === c ? (s.dir > 0 ? 'ascending' : 'descending') : undefined} class={s?.col === c ? (s.dir > 0 ? 'asc' : 'desc') : ''}
              onClick={() => { sortBy.value = s?.col === c ? (s.dir > 0 ? { col: c, dir: -1 } : null) : { col: c, dir: 1 }; }}>{c}</button>)}
          </div>
          {rows.slice(first, last).map((r, k) => {
            const i = first + k;
            return (
              <div key={r.o.id} role="row" class={`list-row${selected(r) ? ' on' : ''}`} style={{ top: `${(i + 1) * ROW}px` }}
                onMouseDown={(ev) => { if (mode.value === 'view' || (ev.target as HTMLElement).closest('.list-kind')) pick(r, ev as unknown as MouseEvent); }}
                onDblClick={() => { if (mode.value === 'view') { e.select(r.o.keys); e.jumpToSelection(2_000_000); tick.value++; } }}>
                {cols.map((c) => {
                  if (c === 'Object Kind') return <span key={c} role="gridcell" class="list-kind">{r.o.kind}</span>;
                  const p = cell(r, c);
                  if (!p) return <span key={c} role="gridcell" class="list-none" />;
                  if (p.type === 'bool') return <span key={c} role="gridcell" class="list-edit">{mode.value === 'edit' && p.set
                    ? <input type="checkbox" aria-label={c} checked={/^true$/i.test(p.value)} onChange={(ev) => commit(r, p, String((ev.target as HTMLInputElement).checked))} />
                    : (/^true$/i.test(p.value) ? '✓' : '')}</span>;
                  if (mode.value === 'edit' && p.set && editing?.id === r.o.id && editing.col === c) {
                    return <span key={c} role="gridcell" class="list-edit">{p.options
                      ? <select autoFocus aria-label={c} value={p.value} onChange={(ev) => commit(r, p, (ev.target as HTMLSelectElement).value)} onBlur={() => setEditing(null)}>{p.options.map((o) => <option key={o}>{o}</option>)}</select>
                      : <input type="text" autoFocus aria-label={c} defaultValue={p.value} onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === 'Enter') commit(r, p, (ev.target as HTMLInputElement).value); if (ev.key === 'Escape') setEditing(null); }}
                        onBlur={(ev) => commit(r, p, (ev.target as HTMLInputElement).value)} />}</span>;
                  }
                  return <span key={c} role="gridcell" title={p.value} class={mode.value === 'edit' && p.set ? 'list-editable' : undefined}
                    onDblClick={() => { if (mode.value === 'edit' && p.set) setEditing({ id: r.o.id, col: c }); }}>{p.value}</span>;
                })}
              </div>
            );
          })}
        </div>
      </div>
      <footer class="insp-foot">{rows.length} Objects ({rows.filter(selected).length} Selected)</footer>
    </section>
  );
}
