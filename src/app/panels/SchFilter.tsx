import { schUnitsOf } from '../newSheet';
import { signal } from '@preact/signals';
import { readLocal, writeLocal } from '../../core/storage';
import { active, activeScope, docs, notify, tick, units } from '../state';
import { openMenuAt } from '../MenuBar';
import { panelTitle } from '../dock/panels';
import { SchEditor } from '../../editors/sch/SchEditor';
import { QUERY_KEYWORDS, QueryError, runSchQuery } from '../../model/schQuery';
import type { AccelNode } from '../../core/keymap';
import { settings } from '../../core/settings';

/**
 * SCH Filter (F12): a query over the schematic's objects — Altium's language, any Inspector
 * property by name — applied to the current document or every open schematic. Objects that
 * pass can be selected and zoomed to; the rest deselected and masked out (faded and out of
 * reach until Clear Filter, Shift+C). Favorites, History and Examples as in Altium.
 */

const FAV_KEY = 'filter.favorites', HIST_KEY = 'filter.history';
const load = (k: string): string[] => { try { const v = JSON.parse(readLocal(k) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; } };
const save = (k: string, v: string[]) => writeLocal(k, JSON.stringify(v));

export const filterQuery = signal('');
export const filterFavorites = () => load(FAV_KEY);
export const setFilterFavorites = (v: string[]) => save(FAV_KEY, v);
export const filterHistory = () => load(HIST_KEY);
export const setFilterHistory = (v: string[]) => save(HIST_KEY, v);
// Preferences › General › Document scope for filtering and selection
const consider = signal<'current' | 'open'>(settings.schFilterScope);
const opt = signal({ select: true, zoom: true, deselect: false, mask: true });
const error = signal('');
const lastCount = signal<string>('');

export const EXAMPLES: [string, string][] = [
  ['All parts', 'IsPart'], ['All wires', 'IsWire'], ['All net labels', 'IsNetLabel'], ['All power ports', 'IsPowerObject'],
  ['Parts whose designator starts with U', "IsPart And (Designator Like 'U*')"], ['Resistors with value 10k', "IsPart And HasParameter('Value', '10k')"],
  ['Parts with a 0805 footprint', "IsPart And (CurrentFootprint Like '*0805*')"], ['Hidden pins', 'IsPin And (Hide = True)'],
  ['Net labels named GND', "IsNetLabel And (Text = 'GND')"], ['Objects in U1', "InComponent('U1')"], ['Locked objects', 'Locked = True'],
];

function editors(): SchEditor[] {
  const ed = active.value?.editor;
  if (consider.value === 'open') return docs.value.map((d) => d.editor).filter((e): e is SchEditor => e instanceof SchEditor);
  return ed instanceof SchEditor ? [ed] : [];
}

/** The selection key that picks an object on its sheet (a part's pins and graphics pick the part). */
function keyFor(ed: SchEditor, i: number): string {
  const o = ed.doc.objects[i]!, ow = o.owner >= 0 ? ed.doc.objects[o.owner] : undefined;
  return ow?.kind === 'component' && o.kind !== 'text' && !ed.libraryMode ? `o${ow.index}` : `o${i}`;
}

/** Apply: run the query on each document and do what the options say. */
export function applyFilter(src = filterQuery.value): number {
  const eds = editors();
  let total = 0;
  try {
    for (const ed of eds) {
      const name = docs.value.find((d) => d.editor === ed)?.name ?? ed.doc.name;
      const pass = runSchQuery(src, ed.doc, { units: schUnitsOf(ed, units.value), docName: name, libraryMode: ed.libraryMode });
      total += pass.length;
      const o = opt.value;
      if (o.mask) ed.setMask(pass); else ed.setMask(null);
      if (o.select) ed.select(pass.map((i) => keyFor(ed, i)));
      else if (o.deselect) { const keep = new Set(pass.map((i) => keyFor(ed, i))); ed.selection = new Set([...ed.selection].filter((k) => keep.has(k))); ed.invalidateOverlay(); }
      if (o.zoom && pass.length && ed === active.value?.editor) ed.zoomToBox(ed.boundsOf(pass.map((i) => keyFor(ed, i))), 2_000_000);
    }
    error.value = '';
    const t = src.trim();
    if (t) { const h = [t, ...load(HIST_KEY).filter((x) => x !== t)].slice(0, 10); save(HIST_KEY, h); }
    lastCount.value = `${total} object${total === 1 ? '' : 's'} passed`;
  } catch (e) {
    error.value = e instanceof QueryError ? e.message : String(e);
    notify(`Query: ${error.value}`, 'error');
  }
  tick.value++;
  return total;
}

const menuAt = (menu: () => AccelNode) => (e: MouseEvent) => { e.preventDefault(); const b = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenuAt(menu(), b.left, b.bottom + 2); };
const use = (q: string) => () => { filterQuery.value = q; };

function favouritesMenu(): AccelNode {
  const favs = load(FAV_KEY);
  return { key: '', label: 'Favourites', children: [
    ...(favs.length ? favs.map((f): AccelNode => ({ key: '', label: f, action: use(f) })) : [{ key: '', label: '(none)', disabled: true } as AccelNode]),
    { key: 'A', label: 'Add To Favourites', accelAt: 0, separatorBefore: true, disabled: !filterQuery.value.trim(), action: () => { const t = filterQuery.value.trim(); save(FAV_KEY, [t, ...favs.filter((x) => x !== t)].slice(0, 20)); notify('Added to favourites'); } },
    { key: 'C', label: 'Clear Favourites', accelAt: 0, disabled: !favs.length, action: () => save(FAV_KEY, []) },
  ] };
}
function historyMenu(): AccelNode {
  const h = load(HIST_KEY);
  return { key: '', label: 'History', children: h.length ? h.map((f): AccelNode => ({ key: '', label: f, action: use(f) })) : [{ key: '', label: '(empty)', disabled: true }] };
}
function helperMenu(): AccelNode {
  return { key: '', label: 'Helper', children: [
    { key: 'E', label: 'Examples', accelAt: 0, children: EXAMPLES.map(([l, q]): AccelNode => ({ key: '', label: l, action: use(q) })) },
    { key: 'K', label: 'Keywords', accelAt: 0, children: QUERY_KEYWORDS.slice(0, 40).map((k): AccelNode => ({ key: '', label: k, action: () => { filterQuery.value = `${filterQuery.value}${filterQuery.value.trim() ? ' And ' : ''}${k}`; } })) },
    { key: 'O', label: 'Operators', accelAt: 0, children: ['And', 'Or', 'Not', '=', '<>', '<', '>', '<=', '>=', 'Like'].map((k): AccelNode => ({ key: '', label: k, action: () => { filterQuery.value = `${filterQuery.value} ${k} `; } })) },
  ] };
}

export function SchFilterPanel() {
  void tick.value;
  const o = opt.value;
  const setO = (p: Partial<typeof o>) => { opt.value = { ...o, ...p }; };
  return (
    <section class="panel schfilter" aria-label={panelTitle('filter', activeScope.value)}>
      <div class="panel-body filter-body">
        <label class="filter-row">Consider objects in
          <select value={consider.value} onChange={(e) => { consider.value = (e.target as HTMLSelectElement).value as 'current' | 'open'; }}>
            <option value="current">Current Document</option><option value="open">Open Documents</option>
          </select>
        </label>
        <label class="filter-label" for="filter-query">Find items matching these criteria:</label>
        <textarea id="filter-query" class={`filter-query${error.value ? ' bad' : ''}`} rows={5} spellcheck={false} value={filterQuery.value}
          onInput={(e) => { filterQuery.value = (e.target as HTMLTextAreaElement).value; error.value = ''; }}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); applyFilter(); } }} />
        {error.value && <p class="error-text small">{error.value}</p>}
        <div class="filter-buttons">
          <button class="btn" onMouseDown={menuAt(favouritesMenu)}>Favourites</button>
          <button class="btn" onMouseDown={menuAt(historyMenu)}>History</button>
          <button class="btn" onMouseDown={menuAt(helperMenu)}>Helper</button>
        </div>
        <fieldset class="filter-opts"><legend>Objects passing the filter</legend>
          <label><input type="checkbox" checked={o.select} onChange={(e) => setO({ select: (e.target as HTMLInputElement).checked })} />Select</label>
          <label><input type="checkbox" checked={o.zoom} onChange={(e) => setO({ zoom: (e.target as HTMLInputElement).checked })} />Zoom</label>
        </fieldset>
        <fieldset class="filter-opts"><legend>Objects not passing the filter</legend>
          <label><input type="checkbox" checked={o.deselect} onChange={(e) => setO({ deselect: (e.target as HTMLInputElement).checked })} />Deselect</label>
          <label><input type="checkbox" checked={o.mask} onChange={(e) => setO({ mask: (e.target as HTMLInputElement).checked })} />Mask out</label>
        </fieldset>
        <div class="filter-apply">
          <span class="muted small">{lastCount.value}</span>
          <button class="btn default" onClick={() => applyFilter()} title="Apply (Ctrl+Enter)">Apply</button>
        </div>
      </div>
    </section>
  );
}
