/**
 * Schematic commands of 26.019: Edit › Unions; Reports › Port Cross References (Add / Remove,
 * sheet or project); Tools › Convert › Convert Cross Junctions; right-click Place NoERC to
 * Suppress (the violations of the last compile at that spot); Part Actions › Choose Alternate
 * Part; Place › Notes › Ellipse / Rectangle / Polygon; Place › Device Sheet Symbol and the
 * Convert Device Sheet ↔ Schematic Sheet refactors.
 */
import { effect } from '@preact/signals';
import type { Command } from '../core/commands';
import { SCH_UNIT } from '../core/units';
import type { PropertyBag } from '../formats/altium/props';
import { readSchDoc } from '../formats/altium/schdoc';
import { SchEditor } from '../editors/sch/SchEditor';
import { SchShapeTool } from '../editors/sch/SchShapeTool';
import { SchPasteTool } from '../editors/sch/SchPasteTool';
import { bagOf } from '../model/sch';
import { addRecords, replaceBags, setProps } from '../model/schEdit';
import { crossJunctionChanges } from '../model/crossJunctions';
import { portReferences } from '../model/portRefs';
import { ellipseBag, noErcBag, polygonBag, rectBag, symbolForPorts } from '../model/schPlace';
import { ercKind } from '../model/erc';
import { pickFile, type PickedFile } from '../platform/fs';
import { deviceSheetFiles } from './deviceSheets';
import { settings } from '../core/settings';
import { showDialog } from './dialogs';
import { ChooseListDialog } from './dialogs/ChooseList';
import { SpecificNoErcDialog } from './dialogs/ProjectOptions';
import { FilterQueriesDialog } from './dialogs/FilterQueries';
import { PinSwapDialog } from './dialogs/PinSwap';
import { applyFilter, filterQuery } from './panels/SchFilter';
import { sheetPorts } from './hierarchy';
import { activeProject, compiled, projectSheets } from './project';
import { active, docs, markProjectDirty, notify, projects, tick } from './state';
import { compileOptions } from './project';
import { compileProject } from '../model/compile';
import { readVariants, variationOf, writeVariants } from '../model/variants';
import { VariantsDialog } from './dialogs/Variants';
import { applyVariantView, currentVariant } from './variantState';

const SCH = ['sch'] as const;
const sheet = () => { const e = active.value?.editor; return e instanceof SchEditor && !e.libraryMode ? e : null; };
const objAt = (e: SchEditor) => { const k = e.hits(e.cursor)[0]?.key; return k ? e.doc.objects[parseInt(k.slice(1), 10)] : undefined; };
const topOf = (e: SchEditor, i: number) => { let o = e.doc.objects[i]; while (o && o.owner >= 0 && e.doc.objects[o.owner]) o = e.doc.objects[o.owner]; return o; };

/* ─── Unions ─────────────────────────────────────────────────────────────────────────── */

function unionMembers(e: SchEditor, keys: Iterable<string>): number[] {
  const out = new Set<number>();
  for (const k of keys) { const t = topOf(e, parseInt(k.slice(1), 10)); if (t) out.add(t.index); }
  return [...out];
}
function setUnion(e: SchEditor, idx: number[], value: string | null, label: string): void {
  const entries = idx.map((i) => {
    const before = e.doc.records[i + 1]!.bag!;
    const after = before.clone();
    if (value === null) after.delete(SchEditor.UNION_KEY); else after.set(SchEditor.UNION_KEY, value);
    return { index: i, before: before.clone(), after };
  }).filter((x) => x.before.get(SchEditor.UNION_KEY) !== x.after.get(SchEditor.UNION_KEY));
  if (!entries.length) { notify('Nothing to change'); return; }
  e.undo.transact(label, (tx) => tx.add(replaceBags(e.doc, entries)));
  e.invalidate();
}
function createUnion(e: SchEditor): void {
  const idx = unionMembers(e, e.selection);
  if (idx.length < 2) { notify('Select two or more objects to make a union', 'error'); return; }
  const used = e.doc.objects.map((o) => Number(e.unionOf(o.index) ?? 0)).filter((n) => n > 0);
  setUnion(e, idx, String(Math.max(0, ...used) + 1), 'Create union');
  notify(`Union of ${idx.length} objects`);
}
function breakUnion(e: SchEditor, keys: Iterable<string>): void {
  const idx = unionMembers(e, keys).filter((i) => e.unionOf(i));
  // A union left with one member is no union
  const ids = new Set(idx.map((i) => e.unionOf(i)!));
  const rest = e.doc.objects.filter((o) => !idx.includes(o.index) && ids.has(e.unionOf(o.index) ?? '')).map((o) => o.index);
  const lone = rest.filter((i) => rest.filter((j) => e.unionOf(j) === e.unionOf(i)).length < 2);
  setUnion(e, [...idx, ...lone], null, 'Break union');
}

/* ─── Port cross references (shown per sheet; kept for the session) ──────────────────── */

const refsOn = new Set<string>();
let refsSeen = 0;
effect(() => { const n = docs.value.length; if (n !== refsSeen) { refsSeen = n; if (refsOn.size) queueMicrotask(refreshRefs); } });
function refreshRefs(): void {
  for (const d of docs.value) {
    const e = d.editor;
    if (!(e instanceof SchEditor) || e.libraryMode) continue;
    const key = `${d.projectId ?? ''}|${d.name.toLowerCase()}`;
    if (!refsOn.has(key)) { if (e.portRefs) { e.portRefs = null; e.invalidate(); } continue; }
    const p = projects.value.find((x) => x.id === d.projectId) ?? null;
    e.portRefs = () => {
      const sheets = p ? projectSheets(p) : [{ name: d.name, doc: e.doc }];
      return portReferences(sheets, { sheetStyle: settings.schPortRefSheet, location: settings.schPortRefLocation }).get(sheets.find((s) => s.name.toLowerCase() === d.name.toLowerCase())?.name ?? d.name) ?? new Map();
    };
    e.invalidate();
  }
  tick.value++;
}
function portRefs(scope: 'sheet' | 'project', on: boolean): void {
  const d = active.value;
  if (!d) return;
  const list = scope === 'sheet' ? [d] : docs.value.filter((x) => x.projectId === d.projectId && x.doc.kind === 'SchDoc');
  for (const x of list) { const k = `${x.projectId ?? ''}|${x.name.toLowerCase()}`; if (on) refsOn.add(k); else refsOn.delete(k); }
  refreshRefs();
  notify(on ? 'Port cross references shown' : 'Port cross references removed');
}

/* ─── Place NoERC to Suppress ────────────────────────────────────────────────────────── */

function suppressHere(e: SchEditor): void {
  const res = compiled.value;
  const name = active.value?.name ?? '';
  if (!res) { notify('Compile the project first: the violations come from the last compile', 'error'); return; }
  const at = e.snap(e.cursor);
  const near = (k: string) => {
    const m = /^(.*)@(-?\d+),(-?\d+)$/.exec(k);
    return !!m && m[1]!.toLowerCase() === name.toLowerCase() && Math.hypot(Number(m[2]) - at.x, Number(m[3]) - at.y) <= e.gridSize() * 0.6;
  };
  const here = res.result.messages.filter((m) => m.points?.some(near));
  if (!here.length) { notify('No violation of the last compile at the cursor', 'error'); return; }
  const place = (bag: PropertyBag) => { e.undo.transact('Place No ERC', (tx) => tx.add(addRecords(e.doc, [bag]))); e.invalidate(); };
  // Connection Matrix violations: a generic No ERC (pair codes not known [est])
  if (here.some((m) => m.kind === 'Matrix' || !m.kind)) { place(noErcBag(at)); notify('Generic No ERC placed'); return; }
  const labels = [...new Set(here.map((m) => ercKind(m.kind!)?.label).filter((l): l is string => !!l))];
  showDialog(SpecificNoErcDialog, { initial: labels, onOk: (kinds: string[]) => place(noErcBag(at, kinds)) });
}

/* ─── Device sheets ──────────────────────────────────────────────────────────────────── */

/** SYMBOLTYPE of a sheet symbol: 'Normal' or 'DeviceSheet' [est]. */
const DEVICE = 'DeviceSheet';
function toggleDeviceSheet(e: SchEditor, ctx: boolean, to: 'Normal' | typeof DEVICE): void {
  const o = ctx ? objAt(e) : e.selectedIndices().map((i) => e.doc.objects[i]).find((x) => x?.kind === 'sheetsymbol' || (x && e.doc.objects[x.owner]?.kind === 'sheetsymbol'));
  const sym = o?.kind === 'sheetsymbol' ? o : o && o.owner >= 0 ? e.doc.objects[o.owner] : undefined;
  if (sym?.kind !== 'sheetsymbol') { notify('Choose a sheet symbol', 'error'); return; }
  const cur = bagOf(e.doc, sym)?.get('SYMBOLTYPE') ?? 'Normal';
  if ((cur === DEVICE) === (to === DEVICE)) { notify(to === DEVICE ? 'Already a device sheet symbol' : 'Already a schematic sheet symbol'); return; }
  e.undo.transact(to === DEVICE ? 'Convert to device sheet' : 'Convert to schematic sheet', (tx) => tx.add(setProps(e.doc, sym.index, { SYMBOLTYPE: to })));
  e.invalidate();
}
async function placeDeviceSheet(e: SchEditor, picked?: PickedFile): Promise<void> {
  // From the device sheet folders (Preferences › Device Sheets), else a file
  const listed = deviceSheetFiles();
  if (!picked && listed.length) {
    const items = [...listed.map((f) => f.name), 'Browse for a sheet…'];
    showDialog(ChooseListDialog, { title: 'Place Device Sheet Symbol', header: 'Device Sheet', items, onOk: (i: number) => {
      if (i < listed.length) void placeDeviceSheet(e, listed[i]);
      else void pickFile('.SchDoc').then((f) => { if (f) void placeDeviceSheet(e, f); });
    } });
    return;
  }
  const f = picked ?? await pickFile('.SchDoc');
  if (!f) return;
  let ports: { name: string; io: number }[];
  try { ports = sheetPorts(readSchDoc(f.bytes, f.name)); } catch (err) { notify(`${f.name}: ${(err as Error).message}`, 'error'); return; }
  // The device sheet is read where the project's documents are; compile finds it there
  const p = activeProject();
  if (p && !p.files.has(f.name.toLowerCase())) p.files.set(f.name.toLowerCase(), f);
  const items = symbolForPorts(f.name, ports);
  items[0]!.bag.set('SYMBOLTYPE', DEVICE);
  e.setTool(new SchPasteTool(e, { kind: 'sch', ref: { x: 0, y: 0 }, items }, false, { id: 'ad:Sch:PlaceDeviceSheet', what: `device sheet ${f.name}` }));
}

/* ─── Variants ───────────────────────────────────────────────────────────────────────── */

function openVariants(focus?: string): void {
  const p = activeProject() ?? projects.value[0] ?? null;
  if (!p) { notify('Variants belong to a project: open one first', 'error'); return; }
  const parts = compileProject(projectSheets(p), compileOptions(p)).components;
  showDialog(VariantsDialog, { project: p, parts, focus });
}
const partUnder = (e: SchEditor) => { const o = objAt(e); const c = o ? topOf(e, o.index) : undefined; return c?.kind === 'component' ? c : undefined; };
function toggleFitted(e: SchEditor): void {
  const p = activeProject();
  const c = partUnder(e);
  if (!p || !c) return;
  const name = currentVariant(p.id);
  const list = readVariants(p.prj);
  const v = list.find((x) => x.name === name);
  if (!v) { notify('Choose a current variant first (Project › Variants)', 'error'); return; }
  const uid = bagOf(e.doc, c)?.get('UNIQUEID') ?? '';
  const now = variationOf(v, c.designator, uid);
  v.variations = v.variations.filter((x) => x !== now);
  if (!now || now.kind !== 1) v.variations.push({ designator: c.designator, uniqueId: now?.uniqueId || uid, kind: 1, alternate: now?.alternate ?? '', fields: [] });
  writeVariants(p.prj, list);
  markProjectDirty(p);
  applyVariantView();
  notify(`${c.designator} ${now?.kind === 1 ? 'fitted' : 'not fitted'} in ${name}`);
}

/* ─── Filter For: the object under the cursor's kind and name ────────────────────────── */

function filterForQuery(): { label: string; query: string } | null {
  const e = active.value?.editor;
  if (!(e instanceof SchEditor)) return null;
  const o = objAt(e);
  if (!o) return null;
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const c = topOf(e, o.index);
  if (c?.kind === 'component' && !e.libraryMode) return { label: `Part ${c.designator}`, query: `IsPart And (Designator = ${q(c.designator)})` };
  switch (o.kind) {
    case 'text': return o.role === 'netlabel' ? { label: `Net Label ${o.text}`, query: `IsNetLabel And (Text = ${q(o.text)})` } : { label: `Text ${o.text}`, query: `(Text = ${q(o.text)})` };
    case 'power': return { label: `Power Port ${o.text}`, query: `IsPowerObject And (Text = ${q(o.text)})` };
    case 'port': return { label: `Port ${o.name}`, query: `IsPort And (Name = ${q(o.name)})` };
    case 'wire': return { label: 'Wires', query: 'IsWire' };
    case 'pin': return { label: `Pin ${o.designator}`, query: `IsPin And (Designator = ${q(o.designator)})` };
    default: return null;
  }
}

/* ─── Commands ───────────────────────────────────────────────────────────────────────── */

export function schMiscCommands(): Command[] {
  const has = () => !!sheet();
  const onPort = () => { const e = sheet(); return !!e && objAt(e)?.kind === 'port'; };
  const onSymbol = () => { const e = sheet(); const o = e ? objAt(e) : undefined; return !!e && !!o && (o.kind === 'sheetsymbol' || e.doc.objects[o.owner]?.kind === 'sheetsymbol'); };
  const ctxUnion = () => { const e = sheet(); const o = e ? objAt(e) : undefined; return !!e && !!o && !!e.unionOf(topOf(e, o.index)!.index); };
  const draw = (id: string, what: string, spec: Partial<ConstructorParameters<typeof SchShapeTool>[1]>) => (): void => {
    const e = sheet();
    if (e) e.setTool(new SchShapeTool(e, { id, what, clicks: 2, build: () => [], ...spec } as ConstructorParameters<typeof SchShapeTool>[1]));
  };
  // Notes as marking-up shapes: pale yellow, see-through [est: AD17's note shapes]
  const noteStyle = (b: PropertyBag) => { b.set('AREACOLOR', '13434879'); b.set('COLOR', '32896'); b.set('TRANSPARENT', 'T'); return b; };
  return [
    // Unions
    { id: 'ad:Sch:CreateUnion', label: 'Create Union from selected objects', scopes: [...SCH], enabled: () => (sheet()?.selection.size ?? 0) > 1, run: () => { const e = sheet(); if (e) createUnion(e); } },
    { id: 'ad:Sch:CreateUnionWithContext', label: 'Create Union from selected objects', scopes: [...SCH], enabled: () => (sheet()?.selection.size ?? 0) > 1, run: () => { const e = sheet(); if (e) createUnion(e); } },
    { id: 'ad:Sch:BreakUnion', label: 'Break objects from Union', scopes: [...SCH], enabled: () => { const e = sheet(); return !!e && [...e.selection].some((k) => e.unionOf(parseInt(k.slice(1), 10))); }, run: () => { const e = sheet(); if (e) breakUnion(e, e.selection); } },
    { id: 'ad:Sch:BreakUnionWithContext', label: 'Break objects from Union', scopes: [...SCH], enabled: ctxUnion, run: () => { const e = sheet(); const o = e ? objAt(e) : undefined; if (e && o) breakUnion(e, e.unionKeys(`o${topOf(e, o.index)!.index}`)); } },
    { id: 'ad:Sch:BreakAllUnions', label: 'Break all objects Unions', scopes: [...SCH], enabled: () => { const e = sheet(); return !!e && e.doc.objects.some((o) => e.unionOf(o.index)); },
      run: () => { const e = sheet(); if (e) setUnion(e, e.doc.objects.filter((o) => e.unionOf(o.index)).map((o) => o.index), null, 'Break all unions'); } },
    { id: 'ad:Sch:SelectAllInUnionWithContext', label: 'Select All In Union', scopes: [...SCH], enabled: ctxUnion, run: () => { const e = sheet(); const o = e ? objAt(e) : undefined; if (e && o) e.select(e.unionKeys(`o${topOf(e, o.index)!.index}`), false); } },
    { id: 'ad:Sch:DeSelectAllInUnionWithContext', label: 'Deselect All In Union', scopes: [...SCH], enabled: ctxUnion, run: () => {
      const e = sheet(); const o = e ? objAt(e) : undefined;
      if (!e || !o) return;
      for (const k of e.unionKeys(`o${topOf(e, o.index)!.index}`)) e.selection.delete(k);
      e.invalidateOverlay();
    } },
    // Port cross references
    ...([['Document', 'sheet'], ['Project', 'project']] as const).flatMap(([what, scope]) => ['', 'WithContext'].flatMap((ctx): Command[] => [
      { id: `ad:Sch:AddPortReference${scope === 'sheet' ? 's' : ''}_${what}${ctx}`, label: scope === 'sheet' ? 'Add To Sheet' : 'Add To Project', scopes: [...SCH], enabled: ctx ? onPort : has, run: () => portRefs(scope, true) },
      { id: `ad:Sch:RemovePortReferences_${what}${ctx}`, label: scope === 'sheet' ? 'Remove From Sheet' : 'Remove From Project', scopes: [...SCH], enabled: ctx ? onPort : has, run: () => portRefs(scope, false) },
    ])),
    // Convert Cross Junctions
    { id: 'ad:Sch:ConvertCrossJunctions', label: 'Convert Cross Junctions', scopes: [...SCH], enabled: has, run: () => {
      const e = sheet();
      if (!e) return;
      const { changes, count } = crossJunctionChanges(e.doc, Math.max(e.gridSize(), 10 * SCH_UNIT));
      if (!count) { notify('No cross junctions on this sheet'); return; }
      e.selection.clear();
      e.undo.transact('Convert cross junctions', (tx) => { for (const c of changes) tx.add(c); });
      e.invalidate();
      notify(`${count} cross junction${count > 1 ? 's' : ''} converted`);
    } },
    { id: 'ad:Sch:SuppressErrorsUnderCursor', label: 'Place NoERC to Suppress...', scopes: [...SCH], enabled: () => !!sheet() && !!compiled.value, run: () => { const e = sheet(); if (e) suppressHere(e); } },
    // Choose Alternate Part: the part's display modes (Normal, Alternate 1 …)
    { id: 'ad:Sch:ChooseComponentAlternatePartWithContext', label: 'Choose Alternate Part...', scopes: [...SCH],
      enabled: () => { const e = sheet(); const o = e ? objAt(e) : undefined; const c = e && o ? topOf(e, o.index) : undefined; return c?.kind === 'component' && (bagOf(e!.doc, c)?.int('DISPLAYMODECOUNT', 1) ?? 1) > 1; },
      run: () => {
        const e = sheet(); const o = e ? objAt(e) : undefined; const c = e && o ? topOf(e, o.index) : undefined;
        if (!e || c?.kind !== 'component') return;
        const n = bagOf(e.doc, c)?.int('DISPLAYMODECOUNT', 1) ?? 1;
        const modes = Array.from({ length: n }, (_, i) => (i ? `Alternate ${i}` : 'Normal'));
        showDialog(ChooseListDialog, { title: `Choose Alternate Part for ${c.designator}`, header: 'Display Mode', items: modes, initial: c.displayMode, onOk: (i: number) => {
          e.undo.transact('Choose alternate part', (tx) => tx.add(setProps(e.doc, c.index, { DISPLAYMODE: i ? String(i) : null })));
          e.invalidate();
        } });
      } },
    // Place › Notes shapes
    { id: 'ad:Sch:PlaceRectangleNote', label: 'Rectangle', scopes: [...SCH], enabled: has, run: draw('ad:Sch:PlaceRectangleNote', 'rectangle note', {
      prompt: (n: number) => (n ? 'click the opposite corner' : 'click the first corner'), build: (pts) => [noteStyle(rectBag(pts[0]!, pts.at(-1)!))] }) },
    { id: 'ad:Sch:PlaceEllipseNote', label: 'Ellipse', scopes: [...SCH], enabled: has, run: draw('ad:Sch:PlaceEllipseNote', 'ellipse note', {
      prompt: (n: number) => (n ? 'click the opposite corner' : 'click the first corner'),
      build: (pts) => { const a = pts[0]!, b = pts.at(-1)!; const rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2; return rx && ry ? [noteStyle(ellipseBag({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, rx, ry))] : []; } }) },
    { id: 'ad:Sch:PlacePolygonNote', label: 'Polygon', scopes: [...SCH], enabled: has, run: draw('ad:Sch:PlacePolygonNote', 'polygon note', {
      clicks: 0, min: 3, build: (pts) => (pts.length >= 2 ? [noteStyle(polygonBag(pts))] : []) }) },
    // Variants
    { id: 'ad:WorkspaceManager:VariantManagement', label: 'Variants...', run: () => openVariants(), enabled: () => projects.value.length > 0 },
    { id: 'ad:WorkspaceManager:VariantManagementFocused', label: 'Variants...', run: () => openVariants(), enabled: () => projects.value.length > 0 },
    ...(['ad:Sch:ComponentVariantWithContext', 'ad:Sch:PhysicalComponentVariantWithContext'] as const).map((id): Command => ({
      id, label: 'Variants...', scopes: [...SCH], enabled: () => { const e = sheet(); return !!e && !!partUnder(e) && !!activeProject(); },
      run: () => { const e = sheet(); const c = e ? partUnder(e) : undefined; openVariants(c?.designator); },
    })),
    { id: 'ad:Sch:ToggleComponentFittedInPhysicalSheetWithContext', label: 'Toggle Fitted/Not Fitted', scopes: [...SCH],
      enabled: () => { const e = sheet(); const p = activeProject(); return !!e && !!partUnder(e) && !!p && !!currentVariant(p.id); },
      run: () => { const e = sheet(); if (e) toggleFitted(e); } },
    { id: 'ad:Sch:ConfigurePinSwap', label: 'Configure Pin Swapping...', scopes: [...SCH], enabled: has, run: () => { const e = sheet(); if (e) showDialog(PinSwapDialog, { ed: e }); } },
    // Right-click › Filter
    { id: 'ad:Sch:FavoriteFiltersMore', label: 'Organise Favourites...', scopes: ['sch', 'schlib'], run: () => showDialog(FilterQueriesDialog, { kind: 'favorites' as const }) },
    { id: 'ad:Sch:HistoryFiltersMore', label: 'More...', scopes: ['sch', 'schlib'], run: () => showDialog(FilterQueriesDialog, { kind: 'history' as const }) },
    { id: 'ad:SCH:FilterExamplesApply', label: 'Examples', scopes: ['sch', 'schlib'], run: () => showDialog(FilterQueriesDialog, { kind: 'examples' as const }) },
    { id: 'ad:Sch:FilterSelect', label: 'Filter For:', scopes: ['sch', 'schlib'], caption: () => { const q = filterForQuery(); return q ? `&Filter For: ${q.label}` : undefined; },
      enabled: () => !!filterForQuery(), run: () => { const q = filterForQuery(); if (q) { filterQuery.value = q.query; applyFilter(q.query); } } },
    // Device sheets
    { id: 'ad:Sch:PlaceDeviceSheet', label: 'Device Sheet Symbol', scopes: [...SCH], enabled: has, run: () => { const e = sheet(); if (e) void placeDeviceSheet(e); } },
    ...([false, true] as const).flatMap((ctx): Command[] => [
      { id: `ad:Sch:RefactorDeviceSheetSymbol${ctx ? 'WithContext' : ''}`, label: 'Convert Device Sheet To Schematic Sheet', scopes: [...SCH], enabled: ctx ? onSymbol : has, run: () => { const e = sheet(); if (e) toggleDeviceSheet(e, ctx, 'Normal'); } },
      { id: `ad:Sch:RefactorNormalSheetSymbol${ctx ? 'WithContext' : ''}`, label: 'Convert Schematic Sheet To Device Sheet', scopes: [...SCH], enabled: ctx ? onSymbol : has, run: () => { const e = sheet(); if (e) toggleDeviceSheet(e, ctx, DEVICE); } },
    ]),
  ];
}

