/**
 * Keeping placed parts in step with their libraries: Tools › Update From Libraries (schematic),
 * Tools › Update Schematics (schematic library editor) and Choose… in a part's properties.
 */
import type { Command, Scope } from '../core/commands';
import type { SchLibrary, LibSymbol } from '../formats/altium/schlib';
import { SchEditor } from '../editors/sch/SchEditor';
import { SchLibEditor } from '../editors/sch/SchLibEditor';
import type { SchDocument } from '../model/sch';
import { currentSymbols } from '../model/schLib';
import { applyPartUpdates, partSource, updatedPart, type UpdateOptions } from '../model/schUpdate';
import { baseName } from '../model/schHierarchy';
import { active, docs, notify, replaceMessages, tick } from './state';
import { availableLibraries } from './dialogs/PlacePart';
import { showDialog } from './dialogs';
import { UpdateFromLibrariesDialog } from './dialogs/UpdateFromLibraries';
import { dbLibSymbolFor } from './dbLibActions';

const SCH: Scope[] = ['sch'];

/** The library symbol a part names: its own library first, else any library with that symbol. */
export function findSymbol(libs: SchLibrary[], library: string, libRef: string): { lib: SchLibrary; sym: LibSymbol } | null {
  if (!libRef) return null;
  const want = baseName(library).toLowerCase();
  const own = want ? libs.find((l) => baseName(l.name).toLowerCase() === want) : undefined;
  const hit = (l: SchLibrary) => l.symbols.find((s) => s.libRef === libRef) ?? l.symbols.find((s) => s.libRef.toLowerCase() === libRef.toLowerCase());
  const s = own && hit(own);
  if (own && s) return { lib: own, sym: s };
  for (const l of libs) { const x = hit(l); if (x) return { lib: l, sym: x }; }
  return null;
}

export interface PartRow { doc: string; index: number; designator: string; libRef: string; library: string; found: { lib: SchLibrary; sym: LibSymbol } | null }

/** Every part on these sheets, with the library symbol it would be updated from. */
export function partsToUpdate(sheets: { name: string; doc: SchDocument }[], libs: SchLibrary[] = availableLibraries()): PartRow[] {
  const out: PartRow[] = [];
  for (const s of sheets) for (const o of s.doc.objects) {
    if (o.kind !== 'component') continue;
    const src = partSource(s.doc, o.index);
    if (!src) continue;
    // A part from a database library: its record's symbol, as the record places it
    const db = /\.(svn)?dblib$/i.test(src.library) ? dbLibSymbolFor(s.doc, o.index, libs) : null;
    out.push({ doc: s.name, index: o.index, designator: o.designator, libRef: src.libRef, library: src.library, found: db ?? findSymbol(libs, src.library, src.libRef) });
  }
  return out;
}

/** Update the chosen parts of one sheet in one undo step; how many changed. */
export function updateSheet(ed: SchEditor, rows: PartRow[], opts: UpdateOptions): number {
  const results = rows.flatMap((r) => { const u = r.found && updatedPart(ed.doc, r.index, r.found.sym, r.found.lib.name, opts); return u ? [u] : []; });
  if (!results.length) return 0;
  ed.undo.transact(`Update ${results.length} part${results.length === 1 ? '' : 's'} from libraries`, (tx) => tx.add(applyPartUpdates(ed.doc, results)));
  ed.clearSelection();
  ed.invalidate();
  return results.length;
}

/** Tools › Update Schematics (library editor): every open sheet's parts from this library, as it is now. */
function updateSchematics(e: SchLibEditor): void {
  const lib: SchLibrary = { name: e.lib.name, header: e.lib.header, symbols: currentSymbols(e.lib) };
  const sheets = docs.value.filter((d) => d.editor instanceof SchEditor && !(d.editor as SchEditor).libraryMode);
  const rows: { doc: string; level: 'info'; message: string }[] = [];
  let parts = 0, sheetsDone = 0;
  for (const d of sheets) {
    const ed = d.editor as SchEditor;
    const mine = partsToUpdate([{ name: d.name, doc: ed.doc }], [lib]).filter((r) => r.found && (!r.library || baseName(r.library).toLowerCase() === baseName(lib.name).toLowerCase()));
    const n = updateSheet(ed, mine, { graphics: true, parameters: 'add', models: true });
    if (n) { parts += n; sheetsDone++; rows.push(...mine.map((r) => ({ doc: d.name, level: 'info' as const, message: `Updated ${r.designator || '(no designator)'} from ${lib.name} › ${r.libRef}` }))); }
  }
  replaceMessages('Update Schematics', [...rows, { doc: lib.name, level: 'info', message: `${parts} part${parts === 1 ? '' : 's'} updated on ${sheetsDone} open sheet${sheetsDone === 1 ? '' : 's'}` }]);
  notify(parts ? `${parts} part${parts === 1 ? '' : 's'} updated on ${sheetsDone} sheet${sheetsDone === 1 ? '' : 's'}` : `No placed parts from ${lib.name} on the open sheets`, parts ? 'ok' : 'error');
  tick.value++;
}

export function libSyncCommands(): Command[] {
  const sheet = () => { const e = active.value?.editor; return e instanceof SchEditor && !e.libraryMode ? e : null; };
  const lib = () => { const e = active.value?.editor; return e instanceof SchLibEditor ? e : null; };
  return [
    { id: 'ad:WorkspaceManager:ConfigureLibrarySynch', label: 'Update From Libraries...', scopes: SCH, run: () => { const e = sheet(); if (e) showDialog(UpdateFromLibrariesDialog, { ed: e }); }, enabled: () => !!sheet() },
    { id: 'ad:Sch:UpdateComponentsFromLibraryEditor', label: 'Update Schematics', scopes: ['schlib'], run: () => { const e = lib(); if (e) updateSchematics(e); }, enabled: () => !!lib() },
  ];
}
