/**
 * Database library commands: File › New › Library › Database Library, Choose Folder (where a
 * library outside a project reads its database and libraries from — an installed one keeps
 * them), and Tools › Update Parameters From Database for the parts placed from a database
 * library (each looked up in its own library's table).
 */
import type { Command } from '../core/commands';
import { newDbLib, writeDbLib } from '../formats/altium/dblib';
import type { DbPart } from '../model/dbParams';
import { pickImportFolder } from '../platform/fs';
import { addNewDocument, freshName } from './actions';
import { dbLibContexts, dbLibData, defaultsOf, folderFromFiles, installedDbLibs, loadDbLib, reloadDbLib, RELEVANT_FOR_DBLIB, setChosenFolder, trimFolder, type DbLibCtx } from './dbLib';
import { notify, tick } from './state';
import { newDocTarget } from './workspace';
import { dbParamChanges, type ParamChange } from '../model/dbParams';
import { dbPartRecords, findDbRecord } from '../model/dbLibParts';
import { recordSymbol, tableOf } from './dbLib';
import { recordModels } from '../model/dbLibParts';
import type { LibSymbol, SchLibrary } from '../formats/altium/schlib';
import { PropertyBag } from '../formats/altium/props';
import { bagOf, ownedBy, SR, type SchDocument } from '../model/sch';

/** Choose Folder: the folder holding the library (or a folder above it) and its database and libraries. */
export async function chooseDbLibFolder(ctx: DbLibCtx): Promise<void> {
  let files;
  try { files = await pickImportFolder(RELEVANT_FOR_DBLIB, 8); } catch (e) { notify(`Couldn't open the folder: ${(e as Error).message}`, 'error'); return; }
  if (!files) return;
  if (!files.length) { notify('That folder holds no database or libraries', 'error'); return; }
  let folder = folderFromFiles(ctx.name, files);
  const inst = installedDbLibs.value.find((x) => x.name.toLowerCase() === ctx.name.toLowerCase());
  if (inst && !ctx.project) {
    // Installed: what it needs is kept with it (between sessions too)
    folder = await trimFolder(ctx.doc(), folder);
    installedDbLibs.value = installedDbLibs.value.map((x) => (x === inst ? { ...x, folder } : x));
  }
  setChosenFolder(ctx.key, folder);
  reloadDbLib(ctx);
  const data = await loadDbLib(ctx);
  tick.value++;
  if (data.error) notify(`${ctx.name}: ${data.error}`, 'error');
  else notify(`${ctx.name}: ${data.tables.reduce((n, t) => n + t.rows.length, 0)} records in ${data.tables.length} table${data.tables.length === 1 ? '' : 's'}, ${data.sch.length} schematic and ${data.pcb.length} PCB librar${data.sch.length + data.pcb.length === 1 ? 'y' : 'ies'}`);
}

/** The database library a placed part came from (by its library name), when in reach. */
export function partDbLib(library: string | undefined): DbLibCtx | undefined {
  if (!library || !/\.(svn)?dblib$/i.test(library)) return undefined;
  return dbLibContexts().find((c) => c.name.toLowerCase() === library.toLowerCase());
}

/** Update Parameters From Database for the parts placed from database libraries: their changes, and how many were found or not. */
export async function dbLibChanges(parts: DbPart[]): Promise<{ changes: ParamChange[]; matched: number; unmatched: DbPart[]; rest: DbPart[] }> {
  const changes: ParamChange[] = [];
  const unmatched: DbPart[] = [];
  const rest: DbPart[] = [];
  let matched = 0;
  const groups = new Map<DbLibCtx, DbPart[]>();
  for (const p of parts) {
    const ctx = partDbLib(p.library);
    if (!ctx) { rest.push(p); continue; }
    groups.set(ctx, [...(groups.get(ctx) ?? []), p]);
  }
  for (const [ctx, list] of groups) {
    const now = dbLibData(ctx);
    const data = now === 'loading' ? await loadDbLib(ctx) : now;
    if (data.error) { notify(`${ctx.name}: ${data.error}`, 'error'); unmatched.push(...list); continue; }
    const doc = ctx.doc();
    const r = dbParamChanges(list, { tables: doc.tables, defaults: defaultsOf(doc) }, data.tables, (p) => p.table);
    matched += r.matched;
    changes.push(...r.changes);
    unmatched.push(...list.filter((p) => r.unmatched.includes(p.designator)));
  }
  return { changes, matched, unmatched, rest };
}

/**
 * Update From Libraries for a part placed from a database library: its record found again (in
 * its table, by the key — the part's key parameter, else its Design Item ID — or the Where
 * clause), and the symbol it names as the record places it (the record's description,
 * parameters and footprints). Null while the library is being read, or when nothing is found.
 */
/** A component's Table Name unticked (USEDBTABLENAME=F): its record may be in any of the library's tables. */
export const anyDbTable = (b: { has(k: string): boolean; bool(k: string): boolean } | undefined): boolean => !!b && b.has('USEDBTABLENAME') && !b.bool('USEDBTABLENAME');

export function dbLibSymbolFor(doc: SchDocument, ci: number, also: SchLibrary[] = []): { lib: SchLibrary; sym: LibSymbol } | null {
  const o = doc.objects[ci];
  const b = o ? bagOf(doc, o) : undefined;
  const ctx = partDbLib(b?.get('SOURCELIBRARYNAME'));
  if (!b || !ctx) return null;
  const data = dbLibData(ctx);
  if (data === 'loading' || data.error) return null;
  const dl = ctx.doc();
  const named = tableOf(dl, b.get('DATABASETABLENAME') ?? '') ?? (dl.tables.length === 1 ? dl.tables[0] : undefined);
  // Table Name unticked (USEDBTABLENAME=F): the named table first, then the library's others
  const defs = anyDbTable(b) ? [...(named ? [named] : []), ...dl.tables.filter((t) => t !== named)] : named ? [named] : [];
  const params = new Map<string, string>();
  for (const k of ownedBy(doc).get(ci) ?? []) { const kb = bagOf(doc, k); if (k.record === SR.PARAMETER && kb?.get('NAME')) params.set(kb.get('NAME')!.toUpperCase(), kb.get('TEXT') ?? ''); }
  const id = b.get('DESIGNITEMID') ?? '';
  let def: (typeof defs)[number] | undefined, table: (typeof data.tables)[number] | undefined, row: Record<string, string> | undefined | null;
  for (const d of defs) {
    const t = data.tables.find((x) => x.name.toLowerCase() === d.name.toLowerCase());
    if (!t) continue;
    const r = findDbRecord(d, t, (n) => params.get(n.trim().toUpperCase()) ?? (n.trim().toLowerCase() === (d.keyParameter || d.keyField).toLowerCase() ? id : undefined));
    if (r) { def = d; table = t; row = r; break; }
  }
  if (!def || !table || !row) return null;
  const m = recordModels(def, table.columns, row);
  const found = m.libRef ? recordSymbol(data, m.libPath, m.libRef, also) : null;
  if (!found) return null;
  const items = dbPartRecords(found.sym, ctx.name, def, table.columns, row, defaultsOf(dl));
  const sym: LibSymbol = { ...found.sym, bags: items.map((it) => it.bag) };
  return { lib: { name: ctx.name, header: new PropertyBag(), symbols: [sym] }, sym };
}

export function dbLibCommands(): Command[] {
  return [
    { id: 'ad:WorkspaceManager:NewDatabaseLib', label: 'Database Library', run: () => {
      const name = freshName('Database_Libs', 'DbLib');
      const od = addNewDocument(name, writeDbLib(newDbLib(name)), newDocTarget());
      if (od?.doc.kind === 'DbLib') { od.doc.dirty = true; tick.value++; }
    } },
  ];
}
