/**
 * Database libraries at work: every DbLib in reach (the projects', open ones, installed ones),
 * the files around each (its database and the symbol and footprint libraries its records name,
 * found by path from the library's folder, in its search paths, or by name), the database's
 * tables read once, and the symbol and footprints a record names. Browsers hand a page only the
 * files picked, so a library outside a project is installed with its folder (chosen once and
 * kept), and a free one asks for its folder when it needs it.
 */
import { signal } from '@preact/signals';
import { dbDefaults, dbSource, readDbLib, searchPaths, type DbDefaults, type DbLibDocument } from '../formats/altium/dblib';
import type { DbTable } from '../formats/altium/dbFile';
import { docBaseName } from '../formats/altium/prjpcb';
import { readSchLib, type LibSymbol, type SchLibrary } from '../formats/altium/schlib';
import { readPcbLib, type Footprint } from '../formats/altium/pcblib';
import { unpackIntLib } from '../formats/altium/intlib';
import { DATA_EXTS, readTables, type DataTable } from '../formats/table';
import { recordModels } from '../model/dbLibParts';
import { hasFolderAccess, type PickedFile } from '../platform/fs';
import { docs, projects, tick, type Project } from './state';

/** A path made plain: '/'-separated, '.' and '..' resolved ('..' past the start kept). */
export function normPath(p: string): string {
  const out: string[] = [];
  for (const s of p.replace(/\\/g, '/').split('/')) {
    if (!s || s === '.') continue;
    if (s === '..' && out.length && out.at(-1) !== '..') out.pop(); else out.push(s);
  }
  return out.join('/');
}
const dirOf = (p: string) => p.split('/').slice(0, -1).join('/');
const join = (a: string, b: string) => normPath(a ? `${a}/${b}` : b);
const isAbsolute = (p: string) => /^[a-z]:[\\/]/i.test(p) || /^[\\/]{2}/.test(p);
const LIB_FILE = /\.(schlib|pcblib|intlib)$/i;
export const DB_FILE = new RegExp(`(${DATA_EXTS.map((e) => e.replace('.', '\\.')).join('|')})$`, 'i');

/** The files around a library: by path from a root ('/'-separated, lower case), the library at `at` from that root; a folder handle reads what wasn't collected. */
export interface DbFolder { files: Map<string, PickedFile>; at: string; dir?: FileSystemDirectoryHandle }

export interface DbLibCtx {
  key: string;
  name: string;
  doc: () => DbLibDocument;
  folder: () => DbFolder | null;
  project?: Project;
  installed?: boolean;
}

/* ─── Installed database libraries ─────────────────────────────────────────────────── */

export interface InstalledDbLib { name: string; bytes: Uint8Array; folder: DbFolder }
export const installedDbLibs = signal<InstalledDbLib[]>([]);
/** Folders chosen this session for libraries outside a project (by key). */
const chosen = new Map<string, DbFolder>();

/* ─── Libraries in reach ───────────────────────────────────────────────────────────── */

const parsed = new WeakMap<Uint8Array, DbLibDocument | null>();
function parseOnce(f: PickedFile): DbLibDocument | null {
  if (!parsed.has(f.bytes)) { try { parsed.set(f.bytes, readDbLib(f.bytes, f.name)); } catch { parsed.set(f.bytes, null); } }
  return parsed.get(f.bytes) ?? null;
}
const openDoc = (name: string, projectId?: string) => docs.value.find((d) => d.doc.kind === 'DbLib' && d.name.toLowerCase() === name.toLowerCase() && (d.projectId ?? undefined) === projectId);

function projectFolderOf(p: Project, docPath: string): DbFolder {
  const files = new Map<string, PickedFile>();
  for (const f of p.files.values()) files.set((f.path ?? f.name).toLowerCase(), f);
  const prjDir = dirOf((p.path ?? '').replace(/\\/g, '/'));
  return { files, at: join(prjDir, docPath.replace(/\\/g, '/')), dir: p.dir };
}

/** Every database library in reach: the projects' (each once), open ones, installed ones. */
export function dbLibContexts(): DbLibCtx[] {
  const out: DbLibCtx[] = [];
  const seen = new Set<string>();
  for (const p of projects.value) {
    for (const path of p.prj.documents) {
      const name = docBaseName(path);
      if (!/\.(svn)?dblib$/i.test(name)) continue;
      const key = `p:${p.id}:${name.toLowerCase()}`;
      if (seen.has(key)) continue;
      const f = p.files.get(name.toLowerCase());
      const od = openDoc(name, p.id);
      if (!od && !f) continue;
      seen.add(key);
      out.push({ key, name, project: p, doc: () => (openDoc(name, p.id)?.doc as DbLibDocument | undefined) ?? parseOnce(f!) ?? readDbLib(new Uint8Array(), name),
        folder: () => chosen.get(key) ?? projectFolderOf(p, path) });
    }
  }
  for (const d of docs.value) {
    if (d.doc.kind !== 'DbLib' || d.projectId) continue;
    const key = `o:${d.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const inst = installedDbLibs.value.find((x) => x.name.toLowerCase() === d.name.toLowerCase());
    out.push({ key, name: d.name, doc: () => d.doc as DbLibDocument, folder: () => chosen.get(key) ?? inst?.folder ?? null });
  }
  for (const i of installedDbLibs.value) {
    const key = `i:${i.name.toLowerCase()}`;
    if (out.some((c) => c.name.toLowerCase() === i.name.toLowerCase())) continue;
    seen.add(key);
    out.push({ key, name: i.name, installed: true, doc: () => parseOnce({ name: i.name, bytes: i.bytes }) ?? readDbLib(new Uint8Array(), i.name), folder: () => chosen.get(key) ?? i.folder });
  }
  return out;
}

/** Choose Folder: the folder a library outside a project reads its files from this session. */
export function setChosenFolder(key: string, f: DbFolder): void { chosen.set(key, f); forget(key); tick.value++; }

/** A file browsed for (the database), at its path from the library: read from there this session (and kept with an installed library). */
export function addFolderFile(ctx: DbLibCtx, rel: string, f: PickedFile): void {
  const base = ctx.folder() ?? { files: new Map<string, PickedFile>(), at: ctx.name.toLowerCase() };
  const path = join(dirOf(base.at), rel);
  const files = new Map(base.files);
  files.set(path.toLowerCase(), { ...f, path });
  const folder: DbFolder = { ...base, files };
  const inst = installedDbLibs.value.find((x) => x.name.toLowerCase() === ctx.name.toLowerCase());
  if (inst && !ctx.project) installedDbLibs.value = installedDbLibs.value.map((x) => (x === inst ? { ...x, folder } : x));
  setChosenFolder(ctx.key, folder);
}

/** A copy of a database the browser can't reach (an ODBC data source, a server): read in its place this session, the library left naming its own. */
const copies = new Map<string, PickedFile>();
export function setDatabaseCopy(ctx: DbLibCtx, f: PickedFile): void { copies.set(ctx.key, f); forget(ctx.key); tick.value++; }
export const databaseCopy = (ctx: DbLibCtx): PickedFile | undefined => copies.get(ctx.key);

/** The context of an open library document. */
export function ctxOfDoc(name: string, projectId?: string): DbLibCtx | undefined {
  return dbLibContexts().find((c) => c.name.toLowerCase() === name.toLowerCase() && (c.project?.id ?? undefined) === projectId);
}

/* ─── Reading the files around a library ───────────────────────────────────────────── */

async function viaHandle(dir: FileSystemDirectoryHandle, path: string): Promise<PickedFile | null> {
  const segs = path.split('/');
  if (segs[0] === '..') return null;
  try {
    let d = dir;
    for (const s of segs.slice(0, -1)) d = await d.getDirectoryHandle(s);
    // Names as the file system has them (Windows paths are any case)
    let h: FileSystemFileHandle | null = null;
    try { h = await d.getFileHandle(segs.at(-1)!); } catch {
      // @ts-expect-error — async iterator on directory handles is not in every lib.dom version
      for await (const [n, x] of d.entries() as AsyncIterable<[string, FileSystemHandle]>) if (x.kind === 'file' && n.toLowerCase() === segs.at(-1)!.toLowerCase()) { h = x as FileSystemFileHandle; break; }
    }
    if (!h) return null;
    const file = await h.getFile();
    return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()), path };
  } catch { return null; }
}

/** A file by its path from the library's folder (an absolute path: by its name, beside the library and then anywhere collected). */
export async function folderFile(f: DbFolder, rel: string): Promise<PickedFile | null> {
  const name = rel.replace(/\\/g, '/').split('/').pop() ?? rel;
  const tries = isAbsolute(rel) ? [join(dirOf(f.at), name)] : [join(dirOf(f.at), rel)];
  for (const t of tries) {
    const hit = f.files.get(t.toLowerCase());
    if (hit) return hit;
    if (f.dir) { const r = await viaHandle(f.dir, t); if (r) { f.files.set(t.toLowerCase(), r); return r; } }
  }
  // By name: the first file of that name collected
  for (const [k, v] of f.files) if (k.split('/').pop() === name.toLowerCase()) return v;
  return null;
}

/** What a library has read: its database's tables, and the symbol and footprint libraries around it. */
export interface DbLibData {
  tables: DataTable[];
  error?: string;
  /** Libraries found, by their path from the root ('' when found by name only). */
  sch: { path: string; lib: SchLibrary }[];
  pcb: { path: string; name: string; footprints: Footprint[] }[];
}

/** Libraries read (with the signature of the document they were read for); a change shows through `state`. */
const cache = new Map<string, { sig: string; data: DbLibData }>();
const pending = new Map<string, string>();
const state = signal(0);
function forget(key: string): void { cache.delete(key); pending.delete(key); state.value++; }

const docSig = (d: DbLibDocument) => `${d.links.map(([k, v]) => `${k}=${v}`).join('|')}#${d.tables.map((t) => `${t.name}:${t.maps.map((m) => `${m.field}>${m.parameter}`).join(',')}`).join(';')}`;

/** The library's data when read (reading it the first time asked), 'loading' meanwhile. */
export function dbLibData(ctx: DbLibCtx): DbLibData | 'loading' {
  void state.value;
  const s = docSig(ctx.doc());
  const have = cache.get(ctx.key);
  if (have && have.sig === s) return have.data;
  if (pending.get(ctx.key) === s) return 'loading';
  pending.set(ctx.key, s);
  void loadDbLib(ctx).catch((e: Error) => ({ tables: [], sch: [], pcb: [], error: e.message }) as DbLibData).then((data) => {
    if (pending.get(ctx.key) !== s) return;
    pending.delete(ctx.key);
    cache.set(ctx.key, { sig: s, data });
    state.value++;
    tick.value++;
  });
  return 'loading';
}
/** Read the library again (its folder or files changed). */
export const reloadDbLib = (ctx: DbLibCtx) => forget(ctx.key);

async function libsFrom(f: PickedFile, path: string, sch: DbLibData['sch'], pcb: DbLibData['pcb']): Promise<void> {
  try {
    if (/\.schlib$/i.test(f.name)) sch.push({ path, lib: readSchLib(f.bytes, f.name) });
    else if (/\.pcblib$/i.test(f.name)) { const l = readPcbLib(f.bytes, f.name); pcb.push({ path, name: l.name, footprints: l.footprints }); }
    else if (/\.intlib$/i.test(f.name)) for (const x of await unpackIntLib(f.bytes, f.name)) await libsFrom({ name: x.name, bytes: x.bytes }, path, sch, pcb);
  } catch { /* not a library Konium Designer reads */ }
}

export async function loadDbLib(ctx: DbLibCtx): Promise<DbLibData> {
  const doc = ctx.doc();
  const folder = ctx.folder();
  const src = dbSource(doc.links);
  const out: DbLibData = { tables: [], sch: [], pcb: [] };
  const copy = copies.get(ctx.key);
  if (!src.file && !copy) { out.error = src.dsn ? `its database is a data source (${src.dsn}) a browser can't reach: point it at a copy of the database (an Access, Excel, CSV or SQLite file)` : 'it has no database yet: choose its database file'; return out; }
  if (!folder && !copy) { out.error = `its folder isn't known: choose the folder that holds ${src.file}`; return out; }
  const db = copy ?? (folder ? await folderFile(folder, src.file) : null);
  if (!db) { out.error = `its database ${src.file} wasn't found${ctx.project && !folder?.dir && !hasFolderAccess() ? ' (this browser reads only the files opened with the project)' : ''}`; return out; }
  try { out.tables = await readTables(db.name, db.bytes); } catch (e) { out.error = `${db.name}: ${(e as Error).message}`; return out; }
  // The libraries its records name, then the ones in its search paths (or beside it)
  const named = new Set<string>();
  for (const t of doc.tables) {
    const data = out.tables.find((d) => d.name.toLowerCase() === t.name.toLowerCase());
    if (!data) continue;
    for (const r of data.rows) {
      const m = recordModels(t, data.columns, r);
      if (m.libPath) named.add(m.libPath);
      for (const fp of m.footprints) if (fp.path) named.add(fp.path);
    }
  }
  const got = new Set<PickedFile>();
  if (!folder) return out;
  for (const p of named) {
    const f = await folderFile(folder, p);
    if (f && !got.has(f)) { got.add(f); await libsFrom(f, (f.path ?? f.name).toLowerCase(), out.sch, out.pcb); }
  }
  const { paths } = searchPaths(doc.links);
  const roots = (paths.length ? paths : ['']).map((p) => join(dirOf(folder.at), p).toLowerCase());
  let inPaths = 0;
  for (const [k, f] of folder.files) {
    if (got.has(f) || !LIB_FILE.test(k)) continue;
    if (roots.some((r) => !r || k.startsWith(`${r}/`))) { got.add(f); inPaths++; await libsFrom(f, k, out.sch, out.pcb); }
  }
  // Search paths outside the folder chosen (or naming none of its libraries): every library in it
  if (!inPaths) for (const [k, f] of folder.files) if (!got.has(f) && LIB_FILE.test(k)) { got.add(f); await libsFrom(f, k, out.sch, out.pcb); }
  return out;
}

/* ─── A record's symbol and footprints ─────────────────────────────────────────────── */

const fileName = (p: string) => p.replace(/\\/g, '/').split('/').pop()!.toLowerCase();

/** The symbol a record names: in the library at its [Library Path] (by path, else by name), else in any library around. */
export function recordSymbol(data: DbLibData, libPath: string, libRef: string, also: SchLibrary[] = []): { sym: LibSymbol; lib: SchLibrary } | null {
  const find = (l: SchLibrary) => l.symbols.find((s) => s.libRef.toLowerCase() === libRef.toLowerCase());
  if (libPath) {
    const n = fileName(libPath), rel = normPath(libPath).toLowerCase();
    const at = data.sch.filter((x) => x.path.endsWith(rel) || fileName(x.path || x.lib.name) === n || x.lib.name.toLowerCase() === n);
    for (const x of at) { const s = find(x.lib); if (s) return { sym: s, lib: x.lib }; }
  }
  for (const l of [...data.sch.map((x) => x.lib), ...also]) { const s = find(l); if (s) return { sym: s, lib: l }; }
  return null;
}

export function recordFootprint(data: DbLibData, path: string, ref: string): { library: string; footprint: Footprint } | null {
  const find = (fps: Footprint[]) => fps.find((f) => f.name.toLowerCase() === ref.toLowerCase());
  if (path) {
    const n = fileName(path);
    for (const x of data.pcb.filter((y) => fileName(y.path || y.name) === n || y.name.toLowerCase() === n)) { const f = find(x.footprints); if (f) return { library: x.name, footprint: f }; }
  }
  for (const x of data.pcb) { const f = find(x.footprints); if (f) return { library: x.name, footprint: f }; }
  return null;
}

/** The PCB libraries the libraries in reach have read (their footprints place and update like installed ones). */
export function dbLibPcbLibraries(): { name: string; footprints: Footprint[] }[] {
  const out: { name: string; footprints: Footprint[] }[] = [];
  void state.value;
  for (const { data } of cache.values()) for (const l of data.pcb) if (!out.some((o) => o.name.toLowerCase() === l.name.toLowerCase())) out.push({ name: l.name, footprints: l.footprints });
  return out;
}

export const tableOf = (doc: DbLibDocument, name: string): DbTable | undefined => doc.tables.find((t) => t.name.toLowerCase() === name.toLowerCase());
export const defaultsOf = (doc: DbLibDocument): DbDefaults => dbDefaults(doc.links);

/* ─── Installing ───────────────────────────────────────────────────────────────────── */

/**
 * A library's folder, from the files under it (paths from the chosen folder, its name first):
 * where the library is among them (by name), and its database and libraries kept.
 */
export function folderFromFiles(name: string, files: PickedFile[]): DbFolder {
  const map = new Map<string, PickedFile>();
  for (const f of files) map.set(normPath(f.path ?? f.name).toLowerCase(), f);
  const self = [...map.keys()].find((k) => k.split('/').pop() === name.toLowerCase());
  return { files: map, at: self ?? name.toLowerCase() };
}

/** What a stored library keeps of its folder: its database, and the libraries it names or that sit in its search paths. */
export async function trimFolder(doc: DbLibDocument, f: DbFolder): Promise<DbFolder> {
  const data = await loadDbLib({ key: '', name: doc.name, doc: () => doc, folder: () => f });
  const keep = new Map<string, PickedFile>();
  const src = dbSource(doc.links);
  const db = src.file ? await folderFile(f, src.file) : null;
  const libs = new Set([...data.sch.map((x) => x.path), ...data.pcb.map((x) => x.path)]);
  for (const [k, v] of f.files) if (v === db || libs.has(k) || k === f.at) keep.set(k, v);
  return { files: keep, at: f.at };
}

export const RELEVANT_FOR_DBLIB = new RegExp(`(\\.(schlib|pcblib|intlib|dblib|svndblib)|${DB_FILE.source.slice(1, -2)})$`, 'i');
