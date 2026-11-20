/**
 * The board's query and selection commands: Build Query, the right-click Filter menu (Examples,
 * History, Organise Favourites, Filter For), zoom to what the filter left, Edit › Change, Select
 * overlapped (Shift+Tab) and Select next (Tab), Clear And Select Neighbours, Browse Objects
 * (Shift+X), Browse Violations (Shift+V), the right-click Violations list, Mask Level.
 */
import type { Command, Scope } from '../core/commands';
import { active, mouse, notify, tick } from './state';
import { showDialog } from './dialogs';
import { openMenuAt } from './MenuBar';
import { showPanel } from './dock/store';
import { BuildQueryDialog } from './dialogs/BuildQuery';
import { InfoDialog } from './dialogs/Confirm';
import { ChooseListDialog } from './dialogs/ChooseList';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { PickTool, maskLevel } from '../editors/Editor';
import { applyPcbFilter, pcbFilterQuery } from './panels/PcbFilter';
import { PCB_EXAMPLES } from '../model/pcbQuery';
import { readLocal, writeLocal } from '../core/storage';
import { boardIndex, distance } from '../model/drc';
import { kindLabel } from '../formats/altium/rules';
import { NO_NET, type PcbPrim } from '../model/pcb';
import { editObject } from './actions';
import type { DrcViolation } from '../model/drc';

const PCB: Scope[] = ['pcb'];
const BOTH: Scope[] = ['pcb', 'pcblib'];
const board = () => { const e = active.value?.editor; return e instanceof PcbEditor ? e : null; };
const keyOfPrim = (p: PcbPrim) => ('polygon' in p && p.polygon !== NO_NET ? `poly:${p.polygon}` : `${p.src.storage}:${p.src.index}`);
const load = (k: string): string[] => { try { const v = JSON.parse(readLocal(k) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; } };
const useQuery = (q: string) => { pcbFilterQuery.value = q; showPanel('filter'); applyPcbFilter('all', q); };

/** Copper of the same net touching these primitives (one step along the copper). */
function neighbours(e: PcbEditor, prims: Set<number>): Set<number> {
  const tree = boardIndex(e.doc);
  const all = tree.all();
  const out = new Set<number>();
  for (const s of all) {
    if (!prims.has(s.prim)) continue;
    for (const o of tree.search({ minX: s.minX - 10, minY: s.minY - 10, maxX: s.maxX + 10, maxY: s.maxY + 10 })) {
      if (prims.has(o.prim) || o.layer !== s.layer || (o.net !== s.net && s.net !== NO_NET)) continue;
      if (distance(s.g, o.g) <= 10) out.add(o.prim);
    }
  }
  return out;
}
const selectedPrims = (e: PcbEditor) => new Set(e.doc.prims.map((p, i) => [p, i] as const).filter(([p]) => e.selection.has(keyOfPrim(p))).map(([, i]) => i));

/** The violations whose markers are under the cursor (or touch what is). */
function violationsAt(e: PcbEditor): DrcViolation[] {
  const keys = new Set(e.hits(e.cursor).map((h) => h.key));
  const near = 30 * 10_000;
  return e.violations.filter((v) => Math.hypot(v.at.x - e.cursor.x, v.at.y - e.cursor.y) < near || v.prims.some((i) => { const p = e.doc.prims[i]; return !!p && keys.has(keyOfPrim(p)); }));
}
function showViolation(e: PcbEditor, v: DrcViolation): void {
  const keys = v.prims.map((i) => e.doc.prims[i]).filter((p): p is PcbPrim => !!p).map(keyOfPrim);
  e.select(keys);
  if (keys.length) e.zoomToBox(e.boundsOf(keys), 2_000_000);
  showDialog(InfoDialog, { title: 'Violation Details', lines: [`${kindLabel(v.kind)} rule: ${v.rule}`, v.message] });
}

export function pcbQueryCommands(): Command[] {
  const cmds: Command[] = [
    { id: 'ad:PCB:BuildQuery', label: 'Build Query...', scopes: BOTH, enabled: () => !!board(), run: () => { const e = board(); if (e) showDialog(BuildQueryDialog, { ed: e }); } },
    { id: 'ad:PCB:BuildQueryUnderCursor', label: 'Build Query...', scopes: BOTH, enabled: () => !!board(), run: () => {
      const e = board(); if (!e) return;
      showDialog(BuildQueryDialog, { ed: e, key: e.contextKey ?? e.hits(e.cursor)[0]?.key });
    } },
    { id: 'ad:PCB:FilterExamplesApply', label: 'Examples', scopes: BOTH, run: () => openMenuAt({ key: '', label: '', children: PCB_EXAMPLES.map(([l, q]) => ({ key: '', label: l, action: () => useQuery(q) })) }, mouse.x, mouse.y) },
    { id: 'ad:PCB:HistoryFiltersMore', label: 'More...', scopes: BOTH, run: () => {
      const h = load('pcbFilter.history');
      if (!h.length) { notify('No queries run yet'); return; }
      showDialog(ChooseListDialog, { title: 'Query History', header: 'Query', items: h, onOk: (i: number) => useQuery(h[i]!) });
    } },
    { id: 'ad:PCB:FavoriteFiltersMore', label: 'Organise Favourites...', scopes: BOTH, run: () => {
      const f = load('pcbFilter.favourites');
      if (!f.length) { notify('No favourite queries: the PCB Filter\'s Favourites › Add To Favourites keeps one'); return; }
      showDialog(ChooseListDialog, { title: 'Organise Favourites: remove one', header: 'Favourite', items: f, onOk: (i: number) => { writeLocal('pcbFilter.favourites', JSON.stringify(f.filter((_, j) => j !== i))); notify('Favourite removed'); } });
    } },
    { id: 'ad:PCB:FilterSelect', label: 'Filter For:', scopes: BOTH, run: () => { showPanel('filter'); setTimeout(() => document.getElementById('pcb-filter-query')?.focus(), 50); } },
    ...['ad:PCB:PopupZoomFiltered', 'ad:PCB:ViewFilteredObjects'].map((id): Command => ({ id, label: id.endsWith('Filtered') ? 'Filtered' : 'Filtered Objects', scopes: BOTH, enabled: () => !!board()?.mask?.size, run: () => {
      const e = board(); if (!e?.mask?.size) return;
      e.zoomToBox(e.boundsOf(e.mask), 2_000_000);
    } })),
    { id: 'ad:PCB:PopupZoomSelect', label: 'Selected', scopes: BOTH, enabled: () => !!board()?.selection.size, run: () => board()?.fitSelection(2_000_000) },
    { id: 'ad:PCB:PopupZoomSheet', label: 'Sheet', scopes: BOTH, enabled: () => !!board(), run: () => board()?.fit() },
    // Edit › Change: click objects one after another to edit each in its dialog
    { id: 'ad:PCB:ChangeObject', label: 'Change', scopes: BOTH, enabled: () => !!board(), run: () => {
      const e = board(); if (!e) return;
      e.setTool(new PickTool(e, 'Change: click an object to edit it; right-click to finish', (p) => {
        const k = e.hits(p.raw)[0]?.key;
        if (k) editObject(e, k);
        return false;
      }));
    } },
    // Shift+Tab: the next object under the cursor; Tab: the copper joined to what is selected, a step at a time
    { id: 'ad:PCB:NextSelection', label: 'Select overlapped', scopes: BOTH, enabled: () => !!board(), run: () => {
      const e = board(); if (!e) return;
      const hits = [...new Set(e.hits(e.cursor).map((h) => h.key))];
      if (!hits.length) return;
      const cur = hits.findIndex((k) => e.selection.has(k));
      e.select(e.keysFor(hits[(cur + 1) % hits.length]!));
      tick.value++;
    } },
    { id: 'ad:PCB:NextTopologySelection', label: 'Select next', scopes: BOTH, enabled: () => !!board()?.selection.size, run: () => {
      const e = board(); if (!e) return;
      const more = neighbours(e, selectedPrims(e));
      if (!more.size) { notify('Nothing more joins the selection'); return; }
      e.select([...more].map((i) => keyOfPrim(e.doc.prims[i]!)), true);
      tick.value++;
    } },
    { id: 'ad:PCB:ClearAndSelect', label: 'Clear And Select Neighbours', scopes: PCB, enabled: () => !!board()?.selection.size, run: () => {
      const e = board(); if (!e) return;
      const sel = selectedPrims(e);
      const keep = [...neighbours(e, sel)].map((i) => e.doc.prims[i]!).filter((p) => !e.selection.has(keyOfPrim(p)));
      e.deleteSelection();
      // The neighbours by what they are, as their records may have moved down
      const sig = new Set(keep.map((p) => JSON.stringify({ ...p, src: undefined })));
      e.select(e.doc.prims.filter((p) => sig.has(JSON.stringify({ ...p, src: undefined }))).map(keyOfPrim));
      tick.value++;
    } },
    // Shift+X: the objects under the cursor; Shift+V: the violations there
    { id: 'ad:PCB:BrowseObjects', label: 'Browse Objects', scopes: PCB, enabled: () => !!board(), run: () => {
      const e = board(); if (!e) return;
      const hits = [...new Set(e.hits(e.cursor).map((h) => h.key))];
      if (!hits.length) { notify('Nothing under the cursor'); return; }
      openMenuAt({ key: '', label: '', children: hits.map((k) => ({ key: '', label: describe(e, k), action: () => { e.select(e.keysFor(k)); tick.value++; } })) }, mouse.x, mouse.y);
    } },
    { id: 'ad:PCB:BrowseViolations', label: 'Browse Violations', scopes: PCB, enabled: () => !!board(), run: () => {
      const e = board(); if (!e) return;
      const vs = violationsAt(e);
      if (!vs.length) { notify('No violations under the cursor'); return; }
      openMenuAt({ key: '', label: '', children: vs.map((v) => ({ key: '', label: v.message.slice(0, 90), action: () => showViolation(e, v) })) }, mouse.x, mouse.y);
    } },
    { id: 'ad:PCB:CurrentViolations', label: 'Show All Violations...', scopes: PCB, enabled: () => !!board()?.violations.length, run: () => { showPanel('rules'); } },
    { id: 'ad:PCB:IncreaseMaskLevel', label: 'Increase Mask Level', scopes: PCB, run: () => { maskLevel.dim = Math.min(0.95, +(maskLevel.dim + 0.1).toFixed(2)); board()?.invalidate(); } },
    { id: 'ad:PCB:DecreaseMaskLevel', label: 'Decrease Mask Level', scopes: PCB, run: () => { maskLevel.dim = Math.max(0, +(maskLevel.dim - 0.1).toFixed(2)); board()?.invalidate(); } },
  ];
  // Right-click › Violations: the ones at the cursor, by their messages
  for (let n = 1; n <= 9; n++) {
    cmds.push({ id: `ad:PCB:CurrentViolation${n}`, label: `Violation${n}`, scopes: PCB, dynamic: true,
      caption: () => { const e = board(); const v = e ? violationsAt(e)[n - 1] : undefined; return v ? v.message.slice(0, 80).replace(/&/g, '&&') : undefined; },
      enabled: () => { const e = board(); return !!e && violationsAt(e).length >= n; },
      run: () => { const e = board(); const v = e ? violationsAt(e)[n - 1] : undefined; if (e && v) showViolation(e, v); } });
  }
  return cmds;
}

function describe(e: PcbEditor, k: string): string {
  if (k.startsWith('poly:')) return `Polygon ${e.doc.polygons[Number(k.slice(5))]?.name ?? ''}`;
  if (k.startsWith('dim:')) return 'Dimension';
  const p = e.primByKey(k);
  if (!p) return k;
  const comp = 'component' in p && p.component !== NO_NET ? e.doc.components[p.component]?.designator : undefined;
  const net = 'net' in p && p.net !== NO_NET ? e.doc.nets[p.net]?.name : undefined;
  const layer = 'layer' in p ? e.layerLabel(p.layer) : 'Multi-Layer';
  const what = p.kind === 'pad' ? `Pad ${comp ? `${comp}-` : ''}${p.name}` : p.kind === 'text' ? `Text "${p.text}"` : p.kind[0]!.toUpperCase() + p.kind.slice(1);
  return `${what}${net ? ` (${net})` : ''} on ${layer}${comp && p.kind !== 'pad' ? `, ${comp}` : ''}`;
}
