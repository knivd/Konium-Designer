/**
 * Hierarchical design on schematics, as Altium Designer 17 does it: Place › Sheet Symbol and
 * Add Sheet Entry; Design › Create Sheet From Sheet Symbol, Create Sheet Symbol From Sheet,
 * Rename Child Sheet; the right-click Sheet Symbol / Sheet Entry / Port Actions; Edit › Move's
 * sheet entry commands; and Tools › Up/Down Hierarchy, which goes down from a sheet symbol or
 * entry to the child sheet and up from a port to the entry it meets.
 */
import type { Command, Scope } from '../core/commands';
import type { Tool, ToolPointer } from '../core/tools';
import type { Vec2 } from '../core/geom';
import { mil } from '../core/units';
import type { PropertyBag } from '../formats/altium/props';
import { PickTool } from '../editors/Editor';
import { SchEditor } from '../editors/sch/SchEditor';
import { SchPasteTool } from '../editors/sch/SchPasteTool';
import { SchShapeTool } from '../editors/sch/SchShapeTool';
import { SheetEntryTool } from '../editors/sch/SheetEntryTool';
import { SR, type SchDocument, type SchObject } from '../model/sch';
import { addRecords, setProps } from '../model/schEdit';
import type { SheetInput } from '../model/compile';
import {
  baseName, childText, entriesOf, entryDistanceProps, hierarchyReport, isEntry, isSymbol, portsOf, resolveSheet, sheetHierarchy, symbolNames, toggledIo,
  type SheetEntryObject, type SheetSymbolObject,
} from '../model/schHierarchy';
import { nextName, portBag, sheetEntryBag, sheetSymbolItems, symbolForPorts } from '../model/schPlace';
import { active, activeId, docs, notify, projects, tick, type OpenDoc, type Project } from './state';
import { projectSheets, whenMounted } from './project';
import { addSheet, openDocument } from './actions';
import { showDialog } from './dialogs';
import { SchObjectDialog } from './dialogs/SchObjectProps';
import { ChooseSheetDialog, RenameChildDialog, ReportDialog, SyncEntriesDialog } from './dialogs/Hierarchy';
import { autoNext } from './increment';
import { settings } from '../core/settings';
import { capture, defaultItems, onSchDefaults, schKind, setSchDefault, withDefault } from '../model/schDefaults';
import { newSheet } from './newSheet';

const SCH: Scope[] = ['sch'];
const sheetEd = (): SchEditor | null => { const e = active.value?.editor; return e instanceof SchEditor && !e.libraryMode ? e : null; };
export const odOf = (ed: SchEditor): OpenDoc | null => docs.value.find((d) => d.editor === ed) ?? null;
const projectOf = (od: OpenDoc | null): Project | null => (od?.projectId ? projects.value.find((p) => p.id === od.projectId) ?? null : null);

/** The sheets a document's symbols can stand for: its project's, or the open free schematics. */
export function sheetsAround(od: OpenDoc | null): { p: Project | null; sheets: SheetInput[] } {
  const p = projectOf(od);
  if (p) return { p, sheets: projectSheets(p) };
  return { p: null, sheets: docs.value.filter((d) => !d.projectId && d.doc.kind === 'SchDoc').map((d) => ({ name: d.name, doc: d.doc as SchDocument })) };
}
const nameIn = (sheets: SheetInput[], od: OpenDoc) => sheets.find((s) => s.name.toLowerCase() === od.name.toLowerCase())?.name ?? od.name;

/** Open (or bring forward) a sheet of the project, or an open free document. */
export function openSheet(name: string, p: Project | null, focus = true): OpenDoc | null {
  const k = name.toLowerCase();
  const open = docs.value.find((d) => d.name.toLowerCase() === k && (p ? d.projectId === p.id : !d.projectId));
  if (open) {
    if (focus) { if (open.hidden) { open.hidden = false; docs.value = [...docs.value]; } activeId.value = open.id; }
    return open;
  }
  const f = p?.files.get(k);
  if (!p || !f) { notify(`${name} isn't loaded: open the project folder`, 'error'); return null; }
  return openDocument(f, p.id, focus);
}

/** What a click landed on (the topmost object). */
function objectAt(ed: SchEditor, raw: Vec2): SchObject | undefined {
  const h = ed.hits(raw)[0];
  return h ? ed.doc.objects[parseInt(h.key.slice(1), 10)] : undefined;
}
/** The sheet symbol an object is, or belongs to (an entry, its designator or file name). */
function symbolOf(doc: SchDocument, o: SchObject | undefined): SheetSymbolObject | undefined {
  if (isSymbol(o)) return o;
  const ow = o && o.owner >= 0 ? doc.objects[o.owner] : undefined;
  return isSymbol(ow) ? ow : undefined;
}

/* ─── Going down and up ──────────────────────────────────────────────────────────────── */

/** Down from a sheet symbol (or one of its entries, to the port it meets) to the child sheet. */
export function goDown(ed: SchEditor, sym: number, entry?: string, keepTool = false): boolean {
  const od = odOf(ed);
  if (!od) return false;
  const { p, sheets } = sheetsAround(od);
  const n = symbolNames(ed.doc, sym);
  const child = resolveSheet(sheets.map((s) => s.name), n.fileName);
  if (!child) { notify(`Child sheet ${n.fileName || '(no file name)'} of ${n.designator || 'the sheet symbol'} isn't in the project`, 'error'); return false; }
  const de = openSheet(child, p)?.editor;
  if (!(de instanceof SchEditor)) return false;
  whenMounted(de, () => {
    const ports = entry === undefined ? [] : portsOf(de.doc).filter((q) => q.name === entry);
    if (ports.length) { de.select(ports.map((q) => `o${q.index}`)); de.jumpToSelection(15_000_000); }
    else { de.clearSelection(); de.fit(); if (entry !== undefined) notify(`No port ${entry} on ${child}`, 'error'); }
    if (keepTool) de.setTool(new HierarchyTool(de));
    tick.value++;
  });
  return true;
}

/** Up from a child sheet (a port, to the entry it meets) to the sheet symbol that stands for it. */
export function goUp(ed: SchEditor, port?: string, keepTool = false): boolean {
  const od = odOf(ed);
  if (!od) return false;
  const { p, sheets } = sheetsAround(od);
  const ups = sheetHierarchy(sheets).parents.get(nameIn(sheets, od).toLowerCase()) ?? [];
  if (!ups.length) { notify(`${od.name} is a top-level sheet: no sheet symbol stands for it`, 'error'); return false; }
  const docOf = (s: string) => sheets.find((x) => x.name === s)?.doc;
  const u = (port !== undefined && ups.find((x) => { const d = docOf(x.sheet); return !!d && entriesOf(d, x.index).some((e) => e.name === port); })) || ups[0]!;
  const de = openSheet(u.sheet, p)?.editor;
  if (!(de instanceof SchEditor)) return false;
  whenMounted(de, () => {
    const es = port === undefined ? [] : entriesOf(de.doc, u.index).filter((e) => e.name === port);
    de.select(es.length ? es.map((e) => `o${e.index}`) : [`o${u.index}`]);
    de.jumpToSelection(15_000_000);
    if (port !== undefined && !es.length) notify(`No sheet entry ${port} on ${u.designator}`, 'error');
    if (keepTool) de.setTool(new HierarchyTool(de));
    tick.value++;
  });
  return true;
}

/** Tools › Up/Down Hierarchy: each click goes down a symbol or entry, or up from a port; the tool follows. */
/**
 * Ctrl+double-click, as AD: on a sheet symbol (or one of its entries) open the child sheet (at the
 * port), on a port go up to the sheet entry. False when there's nothing of the hierarchy there.
 */
export function hierarchyJump(ed: SchEditor, raw: Vec2): boolean {
  const o = objectAt(ed, raw);
  if (!o) return false;
  if (isEntry(o)) { goDown(ed, o.owner, o.name, true); return true; }
  const s = symbolOf(ed.doc, o);
  if (s) { goDown(ed, s.index, undefined, true); return true; }
  if (o.kind === 'port') { goUp(ed, o.name, true); return true; }
  return false;
}

export class HierarchyTool implements Tool {
  readonly id = 'updown-hierarchy';
  constructor(private ed: SchEditor) {}
  hint(): string { return 'Up/Down Hierarchy: click a sheet symbol or sheet entry to go down, a port to go up; right-click to finish'; }
  pointerDown(p: ToolPointer): void {
    if (p.button !== 0) return;
    const o = objectAt(this.ed, p.raw);
    if (!o) return;
    const go = (fn: () => boolean) => { this.ed.setTool(null); if (!fn()) this.ed.setTool(this); };
    if (isEntry(o)) { go(() => goDown(this.ed, o.owner, o.name, true)); return; }
    const s = symbolOf(this.ed.doc, o);
    if (s) { go(() => goDown(this.ed, s.index, undefined, true)); return; }
    if (o.kind === 'port') go(() => goUp(this.ed, o.name, true));
  }
}

/* ─── Creating sheets and symbols ───────────────────────────────────────────────────── */

/** Design › Create Sheet From Sheet Symbol: a new sheet named by the File Name, a port for each entry. */
export function createSheetFromSymbol(ed: SchEditor, sym: number): void {
  const od = odOf(ed);
  const { p, sheets } = sheetsAround(od);
  const n = symbolNames(ed.doc, sym);
  let name = baseName(n.fileName.trim());
  if (!name) { notify('The sheet symbol has no File Name', 'error'); return; }
  if (!/\.schdoc$/i.test(name)) name += '.SchDoc';
  const taken = (x: string) => sheets.some((s) => s.name.toLowerCase() === x.toLowerCase()) || !!p?.files.has(x.toLowerCase())
    || docs.value.some((d) => d.name.toLowerCase() === x.toLowerCase() && d.projectId === od?.projectId);
  if (taken(name)) { notify(`${name} already exists: Up/Down Hierarchy opens it`, 'error'); return; }
  const doc = newSheet(name);
  const es = entriesOf(ed.doc, sym).sort((a, b) => a.side - b.side || a.distance - b.distance);
  addRecords(doc, portColumns(doc, es.map((e) => ({ name: e.name, io: e.io })))).apply();
  const file = childText(ed.doc, sym, SR.FILE_NAME);
  if (file && n.fileName !== name) ed.undo.transact('Sheet symbol file name', (tx) => tx.add(setProps(ed.doc, file.index, { TEXT: name })));
  addSheet(doc, p);
  notify(`Created ${name} with ${es.length} port${es.length === 1 ? '' : 's'}`);
}

/** Ports for entries, down the left of a sheet (outputs down the right), wrapping into more columns. */
function portColumns(doc: SchDocument, list: { name: string; io: number }[], below?: number): PropertyBag[] {
  const W = doc.sheet.width, H = doc.sheet.height;
  const top = below !== undefined && below > mil(1200) ? below : H - mil(1000), step = mil(200);
  const rows = Math.max(1, Math.floor((top - mil(800)) / step) + 1);
  const at = (i: number, right: boolean): Vec2 => {
    const col = Math.floor(i / rows), row = i % rows;
    return right ? { x: W - mil(1500) - col * mil(1500), y: top - row * step } : { x: mil(1000) + col * mil(1500), y: top - row * step };
  };
  const ins = list.filter((e) => e.io !== 1), outs = list.filter((e) => e.io === 1);
  return [...ins.map((e, i) => portBag(e.name, at(i, false), mil(500), 3, e.io)), ...outs.map((e, i) => portBag(e.name, at(i, true), mil(500), 3, e.io))];
}

/** Unique port names of a sheet, in their order, with the first one's I/O type. */
export function sheetPorts(doc: SchDocument): { name: string; io: number }[] {
  const seen = new Map<string, number>();
  for (const q of portsOf(doc).sort((a, b) => b.at.y - a.at.y || a.at.x - b.at.x)) if (!seen.has(q.name)) seen.set(q.name, q.io);
  return [...seen].map(([name, io]) => ({ name, io }));
}

/** Design › Create Sheet Symbol From Sheet: pick the sheet; its symbol follows the cursor. */
function createSymbolFromSheet(ed: SchEditor): void {
  const od = odOf(ed);
  const { sheets } = sheetsAround(od);
  const others = sheets.filter((s) => s.name.toLowerCase() !== od?.name.toLowerCase());
  if (!others.length) { notify('No other schematic sheet in the project to make a symbol for', 'error'); return; }
  showDialog(ChooseSheetDialog, {
    sheets: others.map((s) => s.name),
    onOk: (name: string) => {
      const s = others.find((x) => x.name === name);
      if (!s) return;
      const items = symbolForPorts(s.name, sheetPorts(s.doc));
      ed.setTool(new SchPasteTool(ed, { kind: 'sch', ref: { x: 0, y: 0 }, items }, false, { id: 'ad:Sch:CreateSheetSymbolFromSheet', what: `sheet symbol for ${s.name}`, once: true }));
    },
  });
}

/* ─── Place › Sheet Symbol, Add Sheet Entry ─────────────────────────────────────────── */

/** The number before the extension steps on: Sheet1.SchDoc → Sheet2.SchDoc. */
const nextFile = (f: string) => { const m = /^(.*?)(\d+)(\.[^.]*)?$/.exec(f); return m ? `${nextName(`${m[1]}${m[2]}`)}${m[3] ?? ''}` : f; };

let symTemplate: { bag: PropertyBag; owner: number }[] | null = null;
// Preferences › Default Primitives › Edit Values or Reset: the next symbol or entry starts from the default again
onSchDefaults((name) => { if (!name || name === 'Sheet Symbol') symTemplate = null; if (!name || name === 'Sheet Entry') entryTemplate = null; });
function placeSheetSymbol(e: SchEditor): void {
  const kind = schKind('Sheet Symbol')!;
  // The symbol with its designator and file name, as Preferences › Default Primitives has them (1000 × 800 mil as first made)
  const t = () => (symTemplate ??= defaultItems(e.doc, kind));
  const make = (a: Vec2, c: Vec2, base: number): PropertyBag[] => {
    const [sym, name, file] = t();
    const items = sheetSymbolItems(a, c, name!.bag.get('TEXT') ?? '', file!.bag.get('TEXT') ?? '', sym!.bag);
    return items.map((it, k) => {
      if (k > 0) for (const key of ['COLOR', 'FONTID', 'ISHIDDEN']) { const v = t()[k]!.bag.get(key); if (v !== undefined) it.bag.set(key, v); else it.bag.delete(key); }
      if (it.owner >= 0) it.bag.setRaw('OWNERINDEX', String(base + it.owner));
      return it.bag;
    });
  };
  const size = () => { const s = t()[0]!.bag; return { w: s.int('XSIZE', 100) * 100_000 + s.int('XSIZE_FRAC'), h: s.int('YSIZE', 80) * 100_000 + s.int('YSIZE_FRAC') }; };
  e.setTool(new SchShapeTool(e, {
    id: 'ad:Sch:PlaceSheetSymbol', what: 'sheet symbol', clicks: 2,
    prompt: (n) => (n ? 'click the opposite corner' : 'click the top-left corner (Tab for properties)'),
    ghost: (p, base) => { const { w, h } = size(); return make(p, { x: p.x + w, y: p.y - h }, base); },
    build: (pts, base) => { const a = pts[0]!, c = pts.at(-1)!; if (a.x === c.x || a.y === c.y) { const { w, h } = size(); return make(a, { x: a.x + w, y: a.y - h }, base); } return make(a, c, base); },
    placed: () => {
      const [sym, name, file] = t();
      const n = name!.bag.clone(), f = file!.bag.clone();
      n.set('TEXT', autoNext(n.get('TEXT') ?? '')); f.set('TEXT', nextFile(f.get('TEXT') ?? ''));
      symTemplate = [sym!, { ...name!, bag: n }, { ...file!, bag: f }];
    },
    edit: () => showDialog(SchObjectDialog, { ed: e, templateItems: { items: t(), onOk: (items) => {
      symTemplate = items;
      if (!settings.schDefaultsPermanent) setSchDefault(kind.name, capture(e.doc, kind, items.map((it) => it.bag)), true);
    } } }),
  }));
}

let entryTemplate: PropertyBag | null = null;
function placeSheetEntry(e: SchEditor): void {
  const t = () => (entryTemplate ??= withDefault(e.doc, sheetEntryBag('Entry1', 0, 0)));
  e.setTool(new SheetEntryTool(e, {
    template: t,
    placed: () => { const b = t().clone(); b.set('NAME', autoNext(b.get('NAME') ?? '')); entryTemplate = b; },
    edit: () => showDialog(SchObjectDialog, { ed: e, template: { bag: t(), onOk: (b) => {
      entryTemplate = b;
      const k = schKind('Sheet Entry')!;
      if (!settings.schDefaultsPermanent) setSchDefault(k.name, capture(e.doc, k, [b]), true);
    } } }),
  }));
}

/* ─── Sheet symbol, entry and port actions ──────────────────────────────────────────── */

type Patch = [number, Record<string, string | null>];
function patchAll(ed: SchEditor, label: string, list: Patch[]): void {
  if (!list.length) { notify('Nothing selected that this applies to', 'error'); return; }
  ed.undo.transact(label, (tx) => { for (const [i, props] of list) tx.add(setProps(ed.doc, i, props)); });
  ed.invalidate();
}
const selected = (ed: SchEditor) => ed.selectedIndices().map((i) => ed.doc.objects[i]!);
const selEntries = (ed: SchEditor): SheetEntryObject[] => selected(ed).filter(isEntry);
const selSymbols = (ed: SchEditor): SheetSymbolObject[] => selected(ed).filter(isSymbol);
const io = (v: number) => ({ IOTYPE: v ? String(v) : null });
const side = (v: number) => ({ SIDE: v ? String(v) : null });

export function toggleEntriesIo(ed: SchEditor, es: SheetEntryObject[], label = 'Toggle sheet entries I/O type'): void {
  patchAll(ed, label, es.filter((e) => toggledIo(e.io) !== e.io).map((e) => [e.index, io(toggledIo(e.io))]));
}
export function swapEntrySides(ed: SchEditor, es: SheetEntryObject[]): void {
  patchAll(ed, 'Swap sheet entries sides', es.map((e) => [e.index, side([1, 0, 3, 2][e.side] ?? 0)]));
}
/** Reverse Selected Sheet Entries Order: on each edge, the selected entries trade places end for end. */
export function reverseEntries(ed: SchEditor, es: SheetEntryObject[]): void {
  const groups = new Map<string, SheetEntryObject[]>();
  for (const e of es) { const k = `${e.owner}:${e.side}`; groups.set(k, [...(groups.get(k) ?? []), e]); }
  const list: Patch[] = [];
  for (const g of groups.values()) {
    const sorted = [...g].sort((a, b) => a.distance - b.distance), ds = sorted.map((e) => e.distance).reverse();
    sorted.forEach((e, i) => { if (ds[i] !== e.distance) list.push([e.index, entryDistanceProps(ds[i]!)]); });
  }
  patchAll(ed, 'Reverse sheet entries order', list);
}
/** Flip Selected Sheet Symbols Along X (left ↔ right) or Y (top ↔ bottom): the entries change sides. */
export function flipSymbols(ed: SchEditor, syms: SheetSymbolObject[], axis: 'x' | 'y'): void {
  const list: Patch[] = [];
  for (const s of syms) for (const e of entriesOf(ed.doc, s.index)) {
    const horiz = e.side < 2;
    if (axis === 'x') list.push([e.index, horiz ? side(e.side === 0 ? 1 : 0) : entryDistanceProps(s.w - e.distance)]);
    else list.push([e.index, horiz ? entryDistanceProps(s.h - e.distance) : side(e.side === 2 ? 3 : 2)]);
  }
  patchAll(ed, `Flip sheet symbol${syms.length === 1 ? '' : 's'} along ${axis.toUpperCase()}`, list);
}
export function togglePortsIo(ed: SchEditor): void {
  patchAll(ed, 'Toggle ports I/O type', selected(ed).filter((o): o is SchObject & { kind: 'port' } => o.kind === 'port' && toggledIo(o.io) !== o.io).map((o) => [o.index, io(toggledIo(o.io))]));
}

/** Pick a sheet symbol with a click (Design menu), then act on it. */
function pickSymbol(ed: SchEditor, prompt: string, then: (sym: number) => void): void {
  ed.setTool(new PickTool(ed, prompt, (p) => {
    const s = symbolOf(ed.doc, objectAt(ed, p.raw));
    if (!s) return false;
    setTimeout(() => then(s.index), 0);
    return true;
  }));
}

/** The object under the last right-click, on the active sheet. */
function ctxObject(): { ed: SchEditor; o: SchObject } | null {
  const ed = sheetEd(), k = ed?.contextKey;
  const o = ed && k ? ed.doc.objects[parseInt(k.slice(1), 10)] : undefined;
  return ed && o ? { ed, o } : null;
}
const ctxSymbol = () => { const c = ctxObject(); const s = c ? symbolOf(c.ed.doc, c.o) : undefined; return c && s ? { ed: c.ed, s } : null; };
const ctxEntry = () => { const c = ctxObject(); return c && isEntry(c.o) ? { ed: c.ed, e: c.o } : null; };
const ctxPort = () => { const c = ctxObject(); return c && c.o.kind === 'port' ? { ed: c.ed, o: c.o } : null; };

/* ─── Reports › Report Project Hierarchy ────────────────────────────────────────────── */

function reportHierarchy(): void {
  const od = active.value;
  const { p, sheets } = sheetsAround(od);
  if (!sheets.length) { notify('No schematic sheets to report on', 'error'); return; }
  const project = p?.name ?? od?.name ?? 'Free Documents';
  showDialog(ReportDialog, { title: 'Report Project Hierarchy', name: `${project.replace(/\.[^.]+$/, '')}.REP`, text: hierarchyReport(project, sheetHierarchy(sheets).roots), project: p });
}

/* ─── Commands ──────────────────────────────────────────────────────────────────────── */

export function hierarchyCommands(): Command[] {
  const has = () => !!sheetEd();
  const run = (fn: (e: SchEditor) => void) => () => { const e = sheetEd(); if (e) fn(e); };
  const c = (id: string, label: string, fn: (e: SchEditor) => void, enabled: () => boolean = has): Command => ({ id, label, scopes: SCH, run: run(fn), enabled });
  const rename = (e: SchEditor, sym: number) => showDialog(RenameChildDialog, { ed: e, sym });
  const sync = (e: SchEditor, sym?: number) => showDialog(SyncEntriesDialog, { ed: e, sym });
  return [
    c('ad:Sch:PlaceSheetSymbol', 'Sheet Symbol', placeSheetSymbol),
    c('ad:Sch:PlaceSheetEntry', 'Add Sheet Entry', placeSheetEntry),
    c('ad:Sch:UpDownHierarchy', 'Up/Down Hierarchy', (e) => e.setTool(new HierarchyTool(e))),
    c('ad:Sch:CreateSheetFromSheetSymbol', 'Create Sheet From Sheet Symbol', (e) => pickSymbol(e, 'Create Sheet From Sheet Symbol: choose a sheet symbol', (s) => createSheetFromSymbol(e, s))),
    c('ad:Sch:CreateSheetSymbolFromSheet', 'Create Sheet Symbol From Sheet or HDL', createSymbolFromSheet),
    c('ad:Sch:CreateSheetSymbolFromSheetWithContext', 'Create Sheet Symbol From Sheet or HDL', createSymbolFromSheet),
    c('ad:Sch:RenameSheetSymbolFileName', 'Rename Child Sheet...', (e) => pickSymbol(e, 'Rename Child Sheet: choose a sheet symbol', (s) => rename(e, s))),
    // Right-click › Sheet Symbol Actions
    c('ad:Sch:MoveDownHierarchySheetSymbolWithContext', 'Open SubSheet', () => { const x = ctxSymbol(); if (x) goDown(x.ed, x.s.index); }, () => !!ctxSymbol()),
    c('ad:Sch:CreateSheetFromSheetSymbolWithContext', 'Create Sheet From Sheet Symbol', () => { const x = ctxSymbol(); if (x) createSheetFromSymbol(x.ed, x.s.index); }, () => !!ctxSymbol()),
    c('ad:Sch:RenameSheetSymbolFileNameWithContext', 'Rename Child Sheet...', () => { const x = ctxSymbol(); if (x) rename(x.ed, x.s.index); }, () => !!ctxSymbol()),
    c('ad:Sch:SynchronizeHierarchySheetSymbolWithContext', 'Synchronise Sheet Entries and Ports', () => { const x = ctxSymbol(); if (x) sync(x.ed, x.s.index); }, () => !!ctxSymbol()),
    c('ad:Sch:MirrorXSelectedSheetSymbolWithContext', 'Flip Selected Sheet Symbols Along X', (e) => flipSymbols(e, selSymbols(e), 'x'), () => !!ctxSymbol()),
    c('ad:Sch:MirrorYSelectedSheetSymbolWithContext', 'Flip Selected Sheet Symbols Along Y', (e) => flipSymbols(e, selSymbols(e), 'y'), () => !!ctxSymbol()),
    c('ad:Sch:ToggleIOTypeInSelectedSheetSymbolWithContext', 'Toggle All Sheet Entry IO Type In Selected Sheet Symbols',
      (e) => toggleEntriesIo(e, selSymbols(e).flatMap((s) => entriesOf(e.doc, s.index))), () => !!ctxSymbol()),
    // Right-click › Sheet Entry Actions, Port Actions
    c('ad:Sch:MoveDownHierarchySheetEntryWithContext', 'Jump to Port', () => { const x = ctxEntry(); if (x) goDown(x.ed, x.e.owner, x.e.name); }, () => !!ctxEntry()),
    c('ad:Sch:ToggleSelectedSheetEntryIOWithContext', 'Toggle Selected Sheet Entries IO Type', (e) => toggleEntriesIo(e, selEntries(e)), () => !!ctxEntry()),
    c('ad:Sch:SwapSelectedSheetEntrySideWithContext', 'Swap Selected Sheet Entries Sides', (e) => swapEntrySides(e, selEntries(e)), () => !!ctxEntry()),
    c('ad:Sch:MoveUpHierarchyPortWithContext', 'Jump to Sheet Entry', () => { const x = ctxPort(); if (x) goUp(x.ed, (x.o as SchObject & { kind: 'port' }).name); }, () => !!ctxPort()),
    c('ad:Sch:ToggleSelectedPortsIOWithContext', 'Toggle Selected Sheet Ports IO Type', togglePortsIo, () => !!ctxPort()),
    // Edit › Move
    c('ad:Sch:MirrorXSelectedSheetSymbol', 'Flip Selected Sheet Symbols Along X', (e) => flipSymbols(e, selSymbols(e), 'x')),
    c('ad:Sch:MirrorYSelectedSheetSymbol', 'Flip Selected Sheet Symbols Along Y', (e) => flipSymbols(e, selSymbols(e), 'y')),
    c('ad:Sch:ToggleIOTypeInSelectedSheetSymbol', 'Toggle All Sheet Entry IO Type In Selected Sheet Symbols', (e) => toggleEntriesIo(e, selSymbols(e).flatMap((s) => entriesOf(e.doc, s.index)))),
    c('ad:Sch:ReverseSelectedSheetEntryOrder', 'Reverse Selected Sheet Entries Order', (e) => reverseEntries(e, selEntries(e))),
    c('ad:Sch:ToggleSelectedSheetEntryIO', 'Toggle Selected Sheet Entries IO Type', (e) => toggleEntriesIo(e, selEntries(e))),
    c('ad:Sch:SwapSelectedSheetEntrySide', 'Swap Selected Sheet Entries Sides', (e) => swapEntrySides(e, selEntries(e))),
    { id: 'reports.hierarchy', label: 'Report Project Hierarchy', scopes: SCH, run: reportHierarchy, enabled: () => active.value?.doc.kind === 'SchDoc' },
  ];
}

/** For the Synchronize dialog: add entries for ports (on the symbol) or ports for entries (on the child). */
export function addEntries(ed: SchEditor, sym: number, list: { name: string; io: number }[]): void {
  const s = ed.doc.objects[sym];
  if (!isSymbol(s) || !list.length) return;
  const es = entriesOf(ed.doc, sym);
  const step = mil(100);
  const next = (sideNo: number) => Math.max(0, ...es.filter((e) => e.side === sideNo).map((e) => e.distance)) + step;
  let left = next(0), right = next(1);
  const bags = list.map((x) => {
    const onRight = x.io === 1;
    const d = onRight ? right : left;
    if (onRight) right += step; else left += step;
    const b = sheetEntryBag(x.name, onRight ? 1 : 0, d, x.io);
    b.setRaw('OWNERINDEX', String(sym));
    return b;
  });
  const need = Math.max(left, right);
  ed.undo.transact(`Add ${bags.length} sheet entr${bags.length === 1 ? 'y' : 'ies'}`, (tx) => {
    if (need > s.h) {
      // Grow the symbol to hold them; its File Name stays below the box
      const grow = need - s.h;
      const bag = ed.doc.records[sym + 1]!.bag!;
      const h = bag.int('YSIZE') * 100_000 + bag.int('YSIZE_FRAC') + grow;
      tx.add(setProps(ed.doc, sym, { YSIZE: String(Math.trunc(h / 100_000)), YSIZE_FRAC: h % 100_000 ? String(h % 100_000) : null }));
      const file = childText(ed.doc, sym, SR.FILE_NAME);
      const fb = file ? ed.doc.records[file.index + 1]?.bag : undefined;
      if (file && fb && !fb.bool('OVERRIDENOTAUTOPOSITION')) {
        const y = fb.int('LOCATION.Y') * 100_000 + fb.int('LOCATION.Y_FRAC') - grow;
        tx.add(setProps(ed.doc, file.index, { 'LOCATION.Y': String(Math.trunc(y / 100_000)), 'LOCATION.Y_FRAC': y % 100_000 ? String(y % 100_000) : null }));
      }
    }
    tx.add(addRecords(ed.doc, bags));
  });
}

export function addPorts(ed: SchEditor, list: { name: string; io: number }[]): void {
  if (!list.length) return;
  const lowest = Math.min(...portsOf(ed.doc).map((q) => q.at.y));
  const bags = portColumns(ed.doc, list, Number.isFinite(lowest) ? lowest - mil(200) : undefined);
  ed.undo.transact(`Add ${bags.length} port${bags.length === 1 ? '' : 's'}`, (tx) => tx.add(addRecords(ed.doc, bags)));
}
