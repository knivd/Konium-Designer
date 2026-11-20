/**
 * Database links at work: a DbLink's data file found beside it in the project's folder (or
 * chosen once with the file selector, then kept for the session), its tables read, and
 * Tools › Update Parameters From Database — every part of the project's sheets (or the library
 * component shown) given the values of its record, through Select Parameter Changes.
 */
import type { Command } from '../core/commands';
import { docBaseName } from '../formats/altium/prjpcb';
import { newDbLink, readDbLink, writeDbLink, type DbLinkDocument } from '../formats/altium/dblink';
import { readTables, type DataTable } from '../formats/table';
import { dbParamChanges, type DbPart, type ParamChange } from '../model/dbParams';
import { partParamChange, partParams } from '../model/schParams';
import { ensurePermission, pickFileHandle } from '../platform/fs';
import { addNewDocument, freshName, openDocument, projectFolder } from './actions';
import { newDocTarget } from './workspace';
import { newBomDoc, writeBomDoc } from '../formats/altium/bomdoc';
import { showDialog } from './dialogs';
import { SelectParamChangesDialog } from './dialogs/DbDialogs';
import { activeProject, projectSheets } from './project';
import { active, docs, notify, projects, tick, type OpenDoc, type Project } from './state';
import { SchEditor } from '../editors/sch/SchEditor';
import { SchLibEditor } from '../editors/sch/SchLibEditor';
import { bagOf, type SchDocument } from '../model/sch';
import { anyDbTable, dbLibChanges } from './dbLibActions';

/** Data files read this session, by project and path. */
const files = new Map<string, { name: string; bytes: Uint8Array }>();
const keyOf = (p: Project | null, path: string) => `${p?.id ?? ''}|${path.toLowerCase()}`;


/** The data file's path relative to the project folder: the DbLink's folder joined with its Data Source. */
function dataPath(linkPath: string, source: string): string {
  const segs = linkPath.split('/').slice(0, -1);
  for (const s of source.replace(/\\/g, '/').split('/')) { if (s === '..') segs.pop(); else if (s && s !== '.') segs.push(s); }
  return segs.join('/');
}

/** The link's tables: its data file from the session, else from the project's folder; null when it can't be found. */
export async function linkTables(p: Project | null, linkPath: string, link: DbLinkDocument): Promise<DataTable[] | null> {
  if (!link.source) return null;
  const path = dataPath(linkPath, link.source);
  let f = files.get(keyOf(p, path)) ?? files.get(keyOf(p, docBaseName(path))) ?? p?.files.get(docBaseName(path).toLowerCase());
  if (!f && p?.dir) {
    try {
      if (await ensurePermission(p.dir, 'read')) {
        let d = await projectFolder(p);
        const segs = path.split('/');
        for (const s of segs.slice(0, -1)) d = await d.getDirectoryHandle(s);
        const file = await (await d.getFileHandle(segs.at(-1)!)).getFile();
        f = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
        files.set(keyOf(p, path), f);
      }
    } catch { /* not there */ }
  }
  return f ? readTables(f.name, f.bytes) : null;
}

/** Browse for the data file: kept for the session; the link names it relative to itself when it is in the project's folder. */
export async function chooseDataFile(p: Project | null, linkPath: string, link: DbLinkDocument): Promise<DataTable[] | null> {
  const f = await pickFileHandle(['.xlsx', '.csv'], 'Excel workbooks and CSV files', 'konium-dbdata');
  if (!f) return null;
  let rel = f.name;
  if (p?.dir && f.handle) {
    try {
      const at = await (await projectFolder(p)).resolve(f.handle);
      if (at) {
        const from = linkPath.split('/').slice(0, -1);
        let i = 0;
        while (i < from.length && i < at.length - 1 && from[i]!.toLowerCase() === at[i]!.toLowerCase()) i++;
        rel = [...from.slice(i).map(() => '..'), ...at.slice(i)].join('/');
      }
    } catch { /* outside the folder: by name */ }
  }
  link.source = rel;
  link.dirty = true;
  files.set(keyOf(p, dataPath(linkPath, rel)), { name: f.name, bytes: f.bytes });
  tick.value++;
  return readTables(f.name, f.bytes);
}

/** The project's database links: open ones as they are now, the rest as read from their files. */
export function projectLinks(p: Project): { path: string; link: DbLinkDocument }[] {
  return p.prj.documents.filter((d) => /\.dblink$/i.test(d)).flatMap((path) => {
    const name = docBaseName(path);
    const od = docs.value.find((d) => d.projectId === p.id && d.name.toLowerCase() === name.toLowerCase());
    if (od?.doc.kind === 'DbLink') return [{ path, link: od.doc }];
    const f = p.files.get(name.toLowerCase());
    try { return f ? [{ path, link: readDbLink(f.bytes, name) }] : []; } catch { return []; }
  });
}

/** Tools › Update Parameters From Database. */
async function updateFromDatabase(): Promise<void> {
  const od = active.value;
  const lib = od?.editor instanceof SchLibEditor ? od.editor : null;
  const p = activeProject();
  const owner = p ?? projects.value.find((x) => projectLinks(x).length) ?? null;
  const links = owner ? projectLinks(owner) : [];
  // The parts: the project's sheets, or the library component shown
  const parts: DbPart[] = [];
  const toPart = (sheet: string, doc: SchDocument, l: ReturnType<typeof partParams>[number]): DbPart => {
    const b = bagOf(doc, doc.objects[l.index]!);
    return { sheet, index: l.index, designator: l.designator || l.libRef, params: new Map([...l.params].map(([k, v]) => [k, { name: v.name, value: v.value }])),
      // Table Name unticked (USEDBTABLENAME=F): the record looked for in any of the library's tables
      library: b?.get('SOURCELIBRARYNAME'), table: anyDbTable(b) ? undefined : b?.get('DATABASETABLENAME') };
  };
  if (lib) parts.push(...partParams(lib.doc).map((l) => toPart(od!.name, lib.doc, l)));
  else for (const s of projectSheets(p)) parts.push(...partParams(s.doc).map((l) => toPart(s.name, s.doc, l)));
  if (!parts.length) { notify('No parts to update', 'error'); return; }
  // Parts from database libraries: each in its own library's table; the others through the project's links
  const fromLibs = await dbLibChanges(parts);
  if (!links.length && fromLibs.rest.length === parts.length) { notify('The parts come from no database library in reach, and the project has no database link (.DbLink): add one with File › New › Library › Database Link File', 'error'); return; }
  const all: ParamChange[] = [...fromLibs.changes];
  let matched = fromLibs.matched;
  const unmatched = new Set([...fromLibs.unmatched, ...fromLibs.rest].map((x) => `${x.sheet}|${x.index}`));
  for (const { path, link } of links) {
    const tables = await linkTables(owner, path, link) ?? await chooseDataFile(owner, path, link);
    if (!tables) { notify(`${docBaseName(path)}: its data file ${link.source || '(none chosen)'} wasn't found`, 'error'); continue; }
    const left = fromLibs.rest.filter((x) => unmatched.has(`${x.sheet}|${x.index}`));
    const r = dbParamChanges(left, link, tables);
    matched += r.matched;
    for (const x of left) if (!r.unmatched.includes(x.designator)) unmatched.delete(`${x.sheet}|${x.index}`);
    all.push(...r.changes);
  }
  if (!all.length) { notify(`Parameters match the database: ${matched} part${matched === 1 ? '' : 's'} found, ${unmatched.size} without a record`); return; }
  // The parts' own documents: the library shown, else the project's sheets (a free sheet: itself)
  const free = !p && !lib ? od : null;
  showDialog(SelectParamChangesDialog, { changes: all, matched, unmatched: unmatched.size, onOk: (chosen: ParamChange[]) => apply(p, lib, free, chosen) });
}

function apply(p: Project | null, lib: SchLibEditor | null, free: OpenDoc | null, chosen: ParamChange[]): void {
  const bySheet = new Map<string, ParamChange[]>();
  for (const c of chosen) bySheet.set(c.sheet, [...(bySheet.get(c.sheet) ?? []), c]);
  let n = 0;
  for (const [sheet, list] of bySheet) {
    let ed: SchEditor | null = lib ?? (free?.editor instanceof SchEditor ? free.editor : null);
    if (!ed) {
      const od = docs.value.find((d) => d.name.toLowerCase() === sheet.toLowerCase() && (d.projectId ?? null) === (p?.id ?? null))
        ?? (p ? openDocument(p.files.get(sheet.toLowerCase()) ?? { name: sheet, bytes: new Uint8Array() }, p.id, false) : null);
      ed = od?.editor instanceof SchEditor ? od.editor : null;
    }
    if (!ed) continue;
    const e = ed;
    e.undo.transact('Update parameters from database', (tx) => { for (const c of list) { const ch = partParamChange(e.doc, c.index, c.parameter, c.to); if (ch) { tx.add(ch); n++; } } });
    e.invalidate();
  }
  tick.value++;
  notify(`${n} parameter${n === 1 ? '' : 's'} updated from the database`);
}

/** File › New › BOM Document / Library › Database Link File: into the focused project, opened in a tab. */
function newDocument(name: string, bytes: Uint8Array): void {
  const od = addNewDocument(name, bytes, newDocTarget());
  if (od && (od.doc.kind === 'BomDoc' || od.doc.kind === 'DbLink')) { od.doc.dirty = true; tick.value++; }
}

export function dbLinkCommands(): Command[] {
  return [
    { id: 'ad:WorkspaceManager:NewBOM', label: 'BOM Document', run: () => {
      const p = newDocTarget();
      const stem = p ? p.name.replace(/\.[^.]+$/, '') : 'BOM';
      const taken = new Set([...docs.value.map((d) => d.name.toLowerCase()), ...(p ? p.prj.documents.map((d) => docBaseName(d).toLowerCase()) : [])]);
      const name = !taken.has(`${stem}.bomdoc`) ? `${stem}.BomDoc` : freshName(stem, 'BomDoc');
      newDocument(name, writeBomDoc(newBomDoc(name)));
    } },
    { id: 'ad:WorkspaceManager:NewDatabaseLink', label: 'Database Link File', run: () => { const name = freshName('Database_Link', 'DbLink'); newDocument(name, writeDbLink(newDbLink(name))); } },
    { id: 'ad:WorkspaceManager:ConfigureDatabaseUpdate', label: 'Update Parameters From Database...', scopes: ['sch', 'schlib'], run: updateFromDatabase,
      enabled: () => active.value?.editor instanceof SchEditor },
  ];
}
