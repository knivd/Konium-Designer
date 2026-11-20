/**
 * Project › Project Packager: the project as one .zip, under a folder named after it — the
 * project file, its documents as they are now (open ones with their unsaved edits) and, as
 * chosen, the generated outputs and the other files of the project folder [est: AD17's
 * packager options "Generated files" and "Non-project files"; History and preview folders are
 * left out].
 */
import { zip } from '../formats/zip';

export type PackKind = 'project' | 'document' | 'library' | 'output' | 'other';
export interface PackFile { path: string; bytes: Uint8Array; kind: PackKind; modified: boolean }

export interface PackSource {
  /** Project file name (X.PrjPcb, X.LibPkg) and its current bytes. */
  name: string;
  prj: Uint8Array;
  /** The project's documents as the project file lists them (relative, either slash). */
  documents: string[];
  /** Project Options › Output Path (relative), default "Project Outputs for X". */
  outputPath?: string;
  /** Files of the project folder ('/'-separated paths relative to it), when the folder is open. */
  folder: { path: string; bytes: Uint8Array }[];
  /** Files that came with the project, by lower-case base name (when there is no folder). */
  files: Map<string, { name: string; bytes: Uint8Array; path?: string }>;
  /** Open documents' current bytes, by lower-case base name; `dirty` ones count as modified. */
  current: Map<string, { bytes: Uint8Array; dirty: boolean }>;
}

const LIB = /\.(schlib|pcblib|intlib|dblib|dblink|pcb3dlib)$/i;
/** Folders the packager leaves out: local history, previews, logs. */
export const PACK_SKIP = /(^|\/)(History|__Previews|Project Logs for [^/]*)(\/|$)/i;
const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');
const base = (p: string) => norm(p).split('/').pop()!;

/** Everything the package can hold, each with its kind (the dialog ticks them by kind). */
export function packFiles(s: PackSource): PackFile[] {
  const out: PackFile[] = [{ path: s.name, bytes: s.prj, kind: 'project', modified: false }];
  const seen = new Set([s.name.toLowerCase()]);
  const inFolder = new Map(s.folder.map((f) => [norm(f.path).toLowerCase(), f]));
  for (const d of s.documents) {
    const path = norm(d), k = path.toLowerCase(), b = base(d).toLowerCase();
    if (seen.has(k)) continue;
    const cur = s.current.get(b);
    const bytes = cur?.bytes ?? inFolder.get(k)?.bytes ?? s.files.get(b)?.bytes;
    if (!bytes) continue;
    seen.add(k);
    out.push({ path, bytes, kind: LIB.test(path) ? 'library' : 'document', modified: !!cur?.dirty });
  }
  const outputs = norm(s.outputPath || `Project Outputs for ${s.name.replace(/\.[^.]+$/, '')}`).replace(/\/$/, '').toLowerCase();
  for (const f of s.folder) {
    const path = norm(f.path), k = path.toLowerCase();
    if (seen.has(k) || PACK_SKIP.test(path)) continue;
    seen.add(k);
    out.push({ path, bytes: f.bytes, kind: k.startsWith(`${outputs}/`) ? 'output' : LIB.test(path) ? 'library' : 'other', modified: false });
  }
  return out;
}

/** The chosen files zipped under <project>/. */
export function packageZip(project: string, files: PackFile[], when = new Date()): Uint8Array {
  const root = project.replace(/\.[^.]+$/, '');
  return zip(files.map((f) => ({ name: `${root}/${f.path}`, bytes: f.bytes })), when);
}
