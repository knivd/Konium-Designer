/**
 * PCB Filter (F12 on a board or footprint): a query over the board's objects in Altium's
 * language — any property by name, the Is… and In… keywords — applied to all of them, to the
 * selection or to what isn't selected. What passes can be selected and zoomed to; the rest drawn
 * as they are (Normal), faded and out of reach (Mask) or faded (Dim) until Clear Filter (Shift+C).
 * Favourites, History and the Helper as in AD17.
 */
import { signal } from '@preact/signals';
import { readLocal, writeLocal } from '../../core/storage';
import { active, activeScope, notify, tick, units } from '../state';
import { openMenuAt } from '../MenuBar';
import { panelTitle } from '../dock/panels';
import { PcbEditor } from '../../editors/pcb/PcbEditor';
import { QueryError } from '../../model/schQuery';
import { PCB_EXAMPLES, PCB_QUERY_KEYWORDS, runPcbQuery } from '../../model/pcbQuery';
import { pcbObjects, type PcbObj } from '../../model/pcbProps';
import type { AccelNode } from '../../core/keymap';

const FAV_KEY = 'pcbFilter.favourites', HIST_KEY = 'pcbFilter.history';
const load = (k: string): string[] => { try { const v = JSON.parse(readLocal(k) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; } };
const save = (k: string, v: string[]) => writeLocal(k, JSON.stringify(v));

export const pcbFilterQuery = signal('');
const opt = signal({ select: true, zoom: true, others: 'mask' as 'normal' | 'mask' | 'dim' });
const error = signal('');
const lastCount = signal('');

const board = () => { const e = active.value?.editor; return e instanceof PcbEditor ? e : null; };
export const queryCtx = (e: PcbEditor) => ({ doc: e.doc, units: units.value, origin: e.origin(), layerLabel: (l: number) => e.layerLabel(l) });

/** Apply To All / Selected / Deselected: run the query on those objects and do what the options say. */
export function applyPcbFilter(to: 'all' | 'selected' | 'deselected' = 'all', src = pcbFilterQuery.value): number {
  const e = board();
  if (!e) return 0;
  try {
    const sel = new Set(e.selection);
    const objs = pcbObjects(e.doc).filter((o) => to === 'all' || (to === 'selected') === o.keys.some((k) => sel.has(k)));
    const pass = runPcbQuery(src, queryCtx(e), objs);
    showPassing(e, pass);
    error.value = '';
    const t = src.trim();
    if (t) save(HIST_KEY, [t, ...load(HIST_KEY).filter((x) => x !== t)].slice(0, 10));
    lastCount.value = `${pass.length} object${pass.length === 1 ? '' : 's'} passed`;
    tick.value++;
    return pass.length;
  } catch (err) {
    error.value = err instanceof QueryError ? err.message : String(err);
    notify(`Query: ${error.value}`, 'error');
    tick.value++;
    return 0;
  }
}

/** Select, zoom and mask as the filter's options say (Find Similar uses it too). */
export function showPassing(e: PcbEditor, pass: PcbObj[], o = opt.value): void {
  const keys = pass.flatMap((x) => x.keys);
  if (o.others === 'normal') e.setMask(null); else e.setMask(keys, o.others === 'dim');
  if (o.select) e.select(keys);
  if (o.zoom && keys.length) e.zoomToBox(e.boundsOf(keys), 2_000_000);
  e.invalidateOverlay();
}

const menuAt = (menu: () => AccelNode) => (ev: MouseEvent) => { ev.preventDefault(); const b = (ev.currentTarget as HTMLElement).getBoundingClientRect(); openMenuAt(menu(), b.left, b.bottom + 2); };
const use = (q: string) => () => { pcbFilterQuery.value = q; };
function favouritesMenu(): AccelNode {
  const favs = load(FAV_KEY);
  return { key: '', label: 'Favourites', children: [
    ...(favs.length ? favs.map((f): AccelNode => ({ key: '', label: f, action: use(f) })) : [{ key: '', label: '(none)', disabled: true } as AccelNode]),
    { key: 'A', label: 'Add To Favourites', accelAt: 0, separatorBefore: true, disabled: !pcbFilterQuery.value.trim(), action: () => { const t = pcbFilterQuery.value.trim(); save(FAV_KEY, [t, ...favs.filter((x) => x !== t)].slice(0, 20)); notify('Added to favourites'); } },
    { key: 'C', label: 'Clear Favourites', accelAt: 0, disabled: !favs.length, action: () => save(FAV_KEY, []) },
  ] };
}
function historyMenu(): AccelNode {
  const h = load(HIST_KEY);
  return { key: '', label: 'History', children: h.length ? h.map((f): AccelNode => ({ key: '', label: f, action: use(f) })) : [{ key: '', label: '(empty)', disabled: true }] };
}
function helperMenu(): AccelNode {
  const append = (k: string) => () => { pcbFilterQuery.value = `${pcbFilterQuery.value}${pcbFilterQuery.value.trim() ? ' And ' : ''}${k}`; };
  return { key: '', label: 'Helper', children: [
    { key: 'E', label: 'Examples', accelAt: 0, children: PCB_EXAMPLES.map(([l, q]): AccelNode => ({ key: '', label: l, action: use(q) })) },
    { key: 'K', label: 'Keywords', accelAt: 0, children: PCB_QUERY_KEYWORDS.map((k): AccelNode => ({ key: '', label: k, action: append(k) })) },
    { key: 'O', label: 'Operators', accelAt: 0, children: ['And', 'Or', 'Not', '=', '<>', '<', '>', '<=', '>=', 'Like'].map((k): AccelNode => ({ key: '', label: k, action: () => { pcbFilterQuery.value = `${pcbFilterQuery.value} ${k} `; } })) },
  ] };
}

export function PcbFilterPanel() {
  void tick.value;
  const o = opt.value;
  const setO = (p: Partial<typeof o>) => { opt.value = { ...o, ...p }; };
  const e = board();
  return (
    <section class="panel pcbfilter" aria-label={panelTitle('filter', activeScope.value)}>
      <div class="panel-body filter-body">
        <label class="filter-label" for="pcb-filter-query">Find items matching these criteria:</label>
        <textarea id="pcb-filter-query" class={`filter-query${error.value ? ' bad' : ''}`} rows={5} spellcheck={false} value={pcbFilterQuery.value}
          onInput={(ev) => { pcbFilterQuery.value = (ev.target as HTMLTextAreaElement).value; error.value = ''; }}
          onKeyDown={(ev) => { ev.stopPropagation(); if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); applyPcbFilter(); } }} />
        {error.value && <p class="error-text small">{error.value}</p>}
        <div class="filter-buttons">
          <button class="btn" onMouseDown={menuAt(favouritesMenu)}>Favourites</button>
          <button class="btn" onMouseDown={menuAt(historyMenu)}>History</button>
          <button class="btn" onMouseDown={menuAt(helperMenu)}>Helper</button>
        </div>
        <fieldset class="filter-opts"><legend>Objects passing the filter</legend>
          <label><input type="checkbox" checked={o.select} onChange={(ev) => setO({ select: (ev.target as HTMLInputElement).checked })} />Select</label>
          <label><input type="checkbox" checked={o.zoom} onChange={(ev) => setO({ zoom: (ev.target as HTMLInputElement).checked })} />Zoom</label>
        </fieldset>
        <fieldset class="filter-opts"><legend>Objects not passing the filter</legend>
          <select aria-label="Objects not passing the filter" value={o.others} onChange={(ev) => setO({ others: (ev.target as HTMLSelectElement).value as typeof o.others })}>
            <option value="normal">Normal</option><option value="mask">Mask</option><option value="dim">Dim</option>
          </select>
        </fieldset>
        <div class="filter-apply pcb">
          <span class="muted small">{lastCount.value}</span>
          <button class="btn default" disabled={!e} onClick={() => applyPcbFilter('all')} title="Apply To All (Ctrl+Enter)">Apply To All</button>
          <button class="btn" disabled={!e?.selection.size} onClick={() => applyPcbFilter('selected')}>Apply To Selected</button>
          <button class="btn" disabled={!e} onClick={() => applyPcbFilter('deselected')}>Apply To Deselected</button>
        </div>
      </div>
    </section>
  );
}
