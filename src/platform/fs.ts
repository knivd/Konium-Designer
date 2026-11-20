/**
 * File access. Chromium desktop gets the File System Access API (open, save in place, projects
 * with their documents); other browsers fall back to <input type=file> and downloads.
 */

export interface PickedFile {
  name: string;
  bytes: Uint8Array;
  handle?: FileSystemFileHandle;
  /** Path relative to an opened folder, '/'-separated. */
  path?: string;
}

/** Other tools' files File › Open imports (as the Import Wizard does; formats/importers' IMPORT_EXTS). */
export const OTHER_TOOL_EXTS = ['.kicad_pro', '.kicad_sch', '.kicad_pcb', '.kicad_sym', '.kicad_mod', '.kicad_dru', '.kicad_prl', '.xml', '.cvg', '.asc', '.txt', '.json', '.zip', '.epro', '.epro2', '.elibz', '.elibz2', '.efoo', '.esym', '.dsn', '.ses', '.olb', '.brd', '.sch', '.lbr', '.dchxml', '.dipxml', '.elixml', '.libxml', '.dch', '.dip', '.eli', '.edf', '.edn', '.edif', '.eds', '.pcb', '.drawio', '.vsdx'] as `.${string}`[];
const ALTIUM_EXTS = ['.PrjPcb', '.LibPkg', '.PrjMbd', '.PrjHar', '.DsnWrk', '.PCBDwf', '.HarDwf', '.MbsDoc', '.MbaDoc', '.WirDoc', '.LdrDoc', '.DgmDoc', '.drawio', '.Enclosure', '.ReqDoc', '.SchDoc', '.PcbDoc', '.SchLib', '.PcbLib', '.IntLib', '.OutJob', '.BomDoc', '.DbLink', '.DbLib', '.SVNDbLib', '.nsx', '.mdl', '.ckt', '.sdf', '.cir', '.sp', '.step', '.stp', '.stl', '.Cam'];
/** Fabrication files File › Open opens in the CAM editor (their content decides). */
const CAM_FILE_EXTS = ['.gbr', '.ger', '.pho', '.art', '.gtl', '.gbl', '.gto', '.gbo', '.gts', '.gbs', '.gtp', '.gbp', '.gko', '.gm1', '.gd1', '.gg1', '.drl', '.xln', '.nc', '.drd'];

/**
 * An extension the system file selector takes as a filter: Chromium allows letters, digits, '+'
 * and '.', at most 16 characters, and refuses the whole call over one it doesn't (KiCad's
 * .kicad_pcb has an underscore).
 */
export const pickerExt = (e: string): boolean => /^\.[A-Za-z0-9+.]{0,14}[A-Za-z0-9+]$/.test(e);

/** File type filters for showOpenFilePicker: the extensions it takes; the others are reached through All Files. */
export function pickerTypes(list: { description: string; exts: string[] }[]): { description: string; accept: Record<string, `.${string}`[]> }[] {
  return list.flatMap(({ description, exts }) => {
    const ok = exts.filter(pickerExt) as `.${string}`[];
    const left = exts.filter((e) => !pickerExt(e));
    if (!ok.length) return [];
    const kinds = [...new Set(left.map((e) => (/^\.kicad_/i.test(e) ? 'KiCad' : e)))];
    return [{ description: left.length ? `${description} (${kinds.join(', ')}'s: All Files)` : description, accept: { 'application/octet-stream': ok } }];
  });
}

/** A folder the browser knows by name, for a file selector to start in. */
export type WellKnownFolder = 'documents' | 'desktop' | 'downloads';
/** Where file selectors start when nothing else says (Preferences › System › General › Document Path); undefined: where the last one left off. */
let defaultStart: () => WellKnownFolder | undefined = () => undefined;
export function setDefaultStartIn(f: () => WellKnownFolder | undefined): void { defaultStart = f; }
const startOf = (h?: FileSystemHandle): { startIn?: FileSystemHandle | WellKnownFolder } => { const s = h ?? defaultStart(); return s ? { startIn: s } : {}; };

/** showOpenFilePicker, with the filters cleaned; should the browser still refuse them, without filters. */
async function openPicker(o: { id?: string; startIn?: FileSystemHandle; multiple: boolean; types: { description: string; exts: string[] }[] }): Promise<FileSystemFileHandle[]> {
  const types = pickerTypes(o.types);
  const base = { ...(o.id ? { id: o.id } : {}), ...startOf(o.startIn), multiple: o.multiple, excludeAcceptAllOption: false };
  try {
    return await w.showOpenFilePicker!({ ...base, ...(types.length ? { types } : {}) });
  } catch (e) {
    if (e instanceof TypeError && types.length) return w.showOpenFilePicker!(base);
    throw e;
  }
}

type Win = typeof window & {
  showOpenFilePicker?: (o?: unknown) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (o?: unknown) => Promise<FileSystemFileHandle>;
  showDirectoryPicker?: (o?: unknown) => Promise<FileSystemDirectoryHandle>;
  launchQueue?: { setConsumer(cb: (p: { files: FileSystemFileHandle[] }) => void): void };
};
const w = globalThis as unknown as Win; // globalThis so non-browser imports (tests) load

export const hasFsAccess = (): boolean => typeof w.showOpenFilePicker === 'function';
export const hasFolderAccess = (): boolean => typeof w.showDirectoryPicker === 'function';

async function fromHandle(h: FileSystemFileHandle, path?: string): Promise<PickedFile> {
  const f = await h.getFile();
  return { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), handle: h, path };
}

/** where: the folder the file selector starts in, or the id it remembers its last folder by. */
export async function openFiles(where: { id?: string; startIn?: FileSystemHandle } = {}): Promise<PickedFile[]> {
  if (hasFsAccess()) {
    try {
      const hs = await openPicker({ ...where, multiple: true, types: [
        { description: 'Schematic, PCB and project documents', exts: ALTIUM_EXTS },
        { description: 'Other tools\' files to import', exts: OTHER_TOOL_EXTS },
        { description: 'Gerber and NC drill files (CAM editor)', exts: CAM_FILE_EXTS },
      ] });
      return Promise.all(hs.map((h) => fromHandle(h)));
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return [];
      throw e;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = [...ALTIUM_EXTS, ...OTHER_TOOL_EXTS, ...CAM_FILE_EXTS].join(',');
    input.onchange = async () => {
      const files = [...(input.files ?? [])];
      resolve(await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
    };
    input.click();
  });
}

const RELEVANT = /\.(prjpcb|libpkg|prjmbd|prjhar|dsnwrk|schdoc|pcbdoc|schlib|pcblib|intlib|outjob|harness|bomdoc|dblink|dblib|svndblib|nsx|mdl|ckt|sdf|pcbdwf|hardwf|mbsdoc|mbadoc|wirdoc|ldrdoc|dgmdoc|drawio|enclosure|reqdoc)$/i;
const SKIP_DIRS = /^(History|Project Logs|Project Outputs|__Previews|\.)/i;

/** Collect Altium files under a folder (a few levels deep, skipping history/output folders). */
export async function collectFromDirectory(dir: FileSystemDirectoryHandle, maxDepth = 3): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  const walk = async (d: FileSystemDirectoryHandle, prefix: string, depth: number) => {
    // @ts-expect-error — async iterator on directory handles is not in every lib.dom version
    for await (const [name, h] of d.entries() as AsyncIterable<[string, FileSystemHandle]>) {
      // A file that can't be read (a cloud placeholder, removed meanwhile) is left out, not the whole folder
      try {
        if (h.kind === 'file' && RELEVANT.test(name)) out.push(await fromHandle(h as FileSystemFileHandle, prefix + name));
        else if (h.kind === 'directory' && depth < maxDepth && !SKIP_DIRS.test(name)) await walk(h as FileSystemDirectoryHandle, `${prefix}${name}/`, depth + 1);
      } catch (e) { console.warn(`skipped ${prefix}${name}:`, e); }
    }
  };
  await walk(dir, '', 0);
  return out;
}

/** Every file under a folder ('/'-separated paths), folders matching `skip` left out — for the Project Packager. */
export async function collectAll(dir: FileSystemDirectoryHandle, maxDepth = 6, skip = /^(History|__Previews|\.)/i): Promise<PickedFile[]> {
  const out: PickedFile[] = [];
  const walk = async (d: FileSystemDirectoryHandle, prefix: string, depth: number) => {
    for (const e of await listFolder(d)) {
      try {
        if (e.kind === 'file') out.push(await fromHandle(e.handle as FileSystemFileHandle, prefix + e.name));
        else if (depth < maxDepth && !skip.test(e.name)) await walk(e.handle as FileSystemDirectoryHandle, `${prefix}${e.name}/`, depth + 1);
      } catch (err) { console.warn(`skipped ${prefix}${e.name}:`, err); }
    }
  };
  await walk(dir, '', 0);
  return out;
}

/** A folder's entries, folders first, then files, each A–Z. */
export async function listFolder(dir: FileSystemDirectoryHandle): Promise<{ name: string; kind: 'file' | 'directory'; handle: FileSystemHandle }[]> {
  const out: { name: string; kind: 'file' | 'directory'; handle: FileSystemHandle }[] = [];
  // @ts-expect-error — async iterator on directory handles is not in every lib.dom version
  for await (const [name, h] of dir.entries() as AsyncIterable<[string, FileSystemHandle]>) out.push({ name, kind: h.kind, handle: h });
  return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) : a.kind === 'directory' ? -1 : 1));
}

/** One file of the given kinds through the system's file selector (with its handle where the browser gives one); null if cancelled. */
export async function pickFileHandle(exts: string[], description: string, id = 'konium-file'): Promise<PickedFile | null> {
  if (hasFsAccess()) {
    try {
      const [h] = await openPicker({ id, multiple: false, types: [{ description, exts }] });
      return h ? await fromHandle(h) : null;
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return null;
      throw e;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = exts.join(',');
    input.onchange = async () => {
      const f = input.files?.[0];
      resolve(f ? { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } : null);
    };
    input.click();
  });
}

/** File › Open Project: pick a .PrjPcb. Returns null if cancelled. */
export async function pickProjectFile(): Promise<{ handle?: FileSystemFileHandle; file: PickedFile } | null> {
  if (hasFsAccess()) {
    try {
      const [h] = await openPicker({ id: 'konium-project', multiple: false, types: [{ description: 'Projects and workspaces', exts: ['.PrjPcb', '.LibPkg', '.DsnWrk'] }] });
      return h ? { handle: h, file: await fromHandle(h) } : null;
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return null;
      throw e;
    }
  }
  return null;
}

/**
 * Browsers only hand a web app the file that was picked, never its neighbours. To read the
 * project's documents we ask once for the folder, starting the picker inside it.
 * Throws NotAllowedError/SecurityError when the browser wants a fresh click first.
 */
export async function requestProjectFolder(startIn?: FileSystemHandle): Promise<FileSystemDirectoryHandle | null> {
  if (!hasFolderAccess()) return null;
  try {
    return await w.showDirectoryPicker!({ id: 'konium-project-folder', mode: 'readwrite', ...startOf(startIn) });
  } catch (e) {
    if ((e as DOMException).name === 'AbortError') return null;
    throw e;
  }
}

/** Browsers without the File System Access API: choose the project's folder through a classic input. */
export function pickFolderFallback(): Promise<PickedFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    input.onchange = async () => {
      const files = [...(input.files ?? [])].filter((f) => RELEVANT.test(f.name));
      resolve(await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()),
        path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name }))));
    };
    input.click();
  });
}

/**
 * File › Import Wizard › Add Folder: the files under a folder that `want` takes (paths from the
 * folder, its name first), read; null if cancelled.
 */
export async function pickImportFolder(want: RegExp, maxDepth = 6): Promise<PickedFile[] | null> {
  if (hasFolderAccess()) {
    let dir: FileSystemDirectoryHandle;
    try { dir = await w.showDirectoryPicker!({ id: 'konium-import', mode: 'read' }); } catch (e) { if ((e as DOMException).name === 'AbortError') return null; throw e; }
    const out: PickedFile[] = [];
    const walk = async (d: FileSystemDirectoryHandle, prefix: string, depth: number) => {
      for (const e of await listFolder(d)) {
        try {
          if (e.kind === 'file' && want.test(e.name)) out.push(await fromHandle(e.handle as FileSystemFileHandle, prefix + e.name));
          else if (e.kind === 'directory' && depth < maxDepth && !/^(\.|node_modules$|.*-backups$)/i.test(e.name)) await walk(e.handle as FileSystemDirectoryHandle, `${prefix}${e.name}/`, depth + 1);
        } catch (err) { console.warn(`skipped ${prefix}${e.name}:`, err); }
      }
    };
    await walk(dir, `${dir.name}/`, 0);
    return out;
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
    input.onchange = async () => {
      const files = [...(input.files ?? [])].filter((f) => want.test(f.name));
      resolve(await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()),
        path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name }))));
    };
    input.click();
  });
}

/** File › Import Wizard › Add Files: files of the given kinds, read; [] if cancelled. */
export async function pickImportFiles(exts: `.${string}`[], description: string): Promise<PickedFile[]> {
  if (hasFsAccess()) {
    try {
      const hs = await openPicker({ id: 'konium-import', multiple: true, types: [{ description, exts }] });
      return Promise.all(hs.map((h) => fromHandle(h, h.name)));
    } catch (e) { if ((e as DOMException).name === 'AbortError') return []; throw e; }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = exts.join(',');
    input.onchange = async () => resolve(await Promise.all([...(input.files ?? [])].map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), path: f.name }))));
    input.click();
  });
}

/** Re-acquire permission on a remembered folder (needs a click; asks only if not already granted). */
export async function ensurePermission(h: FileSystemHandle, mode: 'read' | 'readwrite' = 'readwrite'): Promise<boolean> {
  const hh = h as FileSystemHandle & { queryPermission?(o: unknown): Promise<string>; requestPermission?(o: unknown): Promise<string> };
  if ((await hh.queryPermission?.({ mode })) === 'granted') return true;
  return (await hh.requestPermission?.({ mode })) === 'granted';
}

/** Save to the existing handle when we have one and permission; otherwise Save As. */
export async function saveFile(name: string, bytes: Uint8Array, handle?: FileSystemFileHandle): Promise<FileSystemFileHandle | undefined | null> {
  if (handle && 'createWritable' in handle) {
    // @ts-expect-error — permission API not yet in lib.dom
    const perm = await handle.requestPermission?.({ mode: 'readwrite' });
    if (perm === undefined || perm === 'granted') {
      try { await writeHandle(handle, bytes); } catch (e) {
        // The file has gone from where it was (moved, renamed or deleted since): where to save is asked again
        if ((e as DOMException)?.name === 'NotFoundError' && !(await exists(handle))) {
          try { return await saveFileAs(name, bytes); } catch { /* no file selector now (too long since the click): downloaded below */ }
        }
        // Otherwise the file keeps what it had: the document as it is now is downloaded, and the save is reported as failed
        throw downloadInstead(name, bytes, e, true);
      }
      return handle;
    }
  }
  return saveFileAs(name, bytes);
}

/**
 * Save through the system's file selector (starting in `startIn` when given): the new handle;
 * null when cancelled; undefined where the browser can only download the file.
 */
/**
 * Where a file will go, asked before the work that makes it (the browser allows a file selector
 * only soon after a click): the handle, null if cancelled, undefined where the browser has no
 * file selector (the file is downloaded when written).
 */
export async function pickSaveHandle(name: string, startIn?: FileSystemHandle): Promise<FileSystemFileHandle | undefined | null> {
  if (typeof w.showSaveFilePicker !== 'function') return undefined;
  try { return await w.showSaveFilePicker({ suggestedName: name, ...startOf(startIn) }); } catch (e) { if ((e as DOMException).name === 'AbortError') return null; throw e; }
}

export async function saveFileAs(name: string, bytes: Uint8Array, startIn?: FileSystemHandle): Promise<FileSystemFileHandle | undefined | null> {
  if (typeof w.showSaveFilePicker === 'function') {
    try {
      const h = await w.showSaveFilePicker({ suggestedName: name, ...startOf(startIn) });
      try { await writeHandle(h, bytes); } catch (e) {
        // The place chosen couldn't be written: the file is downloaded, as where there is no file selector
        downloadInstead(h.name || name, bytes, e, false);
        return undefined;
      }
      return h;
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return null;
      throw e;
    }
  }
  download(name, bytes);
  return undefined;
}

/** A file handed to the browser to download. */
function download(name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart]));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * Bytes written to a file through its handle. The browser writes a temporary file beside it
 * first and swaps it in at the end, so a failed write leaves what was there; but the system's
 * file selector has by then made a new file of that name, empty. Such an empty file is taken
 * away again (it would pass for the saved one), and the failure is thrown on.
 */
export async function writeHandle(h: FileSystemFileHandle, bytes: Uint8Array): Promise<void> {
  let ws: FileSystemWritableFileStream | undefined;
  try {
    ws = await h.createWritable();
    await ws.write(bytes as unknown as BufferSource);
    await ws.close();
  } catch (e) {
    try { await ws?.abort(); } catch { /* closed or gone already */ }
    if (bytes.length) (e as { emptyLeft?: boolean }).emptyLeft = await dropIfEmpty(h);
    throw e;
  }
}
/** Whether the file a handle stands for is still there. */
async function exists(h: FileSystemFileHandle): Promise<boolean> {
  try { await h.getFile(); return true; } catch (e) { return (e as DOMException)?.name !== 'NotFoundError'; }
}
/** An empty file taken away: false when it went (or was never empty), true when it is still there. */
async function dropIfEmpty(h: FileSystemFileHandle): Promise<boolean> {
  try {
    if ((await h.getFile()).size !== 0) return false;
    const rm = (h as FileSystemFileHandle & { remove?(): Promise<void> }).remove;
    if (!rm) return true;
    await rm.call(h);
    return false;
  } catch (e) { return (e as DOMException)?.name !== 'NotFoundError'; }
}

/** A write that failed and what was done about it. */
export interface WriteFallback {
  name: string;
  /** What the browser reported. */
  why: string;
  /** The file was there before and keeps what it had (Save); otherwise a new place was chosen (Save As, an export). */
  existing: boolean;
  /** The document still counts as unsaved (its own file wasn't written); otherwise the download is the saved file. */
  unsaved: boolean;
  /** An empty file of that name may still be at the place chosen. */
  emptyLeft: boolean;
}
let fallbackNotice: (f: WriteFallback) => void = () => {};
/** How the person is told of a file downloaded because its place couldn't be written (a dialog: the app sets it). */
export function setWriteFallbackNotice(f: (x: WriteFallback) => void): void { fallbackNotice = f; }
let fallbacks = 0;
/** How many writes have fallen back to a download so far (a caller compares before and after its save). */
export const writeFallbacks = (): number => fallbacks;

/** The error of a save that could only be downloaded. */
export class WriteFallbackError extends Error {
  constructor(readonly fallback: WriteFallback) { super(`${fallback.name} could not be written to its file (${fallback.why}); the document as it is now was downloaded instead`); this.name = 'WriteFallbackError'; }
}

/**
 * A file that couldn't be written where it was to go: downloaded instead, and the person told.
 * Returns the error for callers whose own file was left unwritten.
 */
export function downloadInstead(name: string, bytes: Uint8Array, cause: unknown, existing: boolean, unsaved = existing): WriteFallbackError {
  const fb: WriteFallback = { name, why: (cause as Error)?.message || String(cause), existing, unsaved, emptyLeft: !!(cause as { emptyLeft?: boolean })?.emptyLeft };
  download(name, bytes);
  fallbacks++;
  fallbackNotice(fb);
  return new WriteFallbackError(fb);
}

/** The lines the person reads when a file was downloaded because its place couldn't be written. */
export function fallbackLines(f: WriteFallback): string[] {
  return [
    f.existing ? `${f.name} could not be written to its file, which keeps what it had. The browser reported: “${f.why}”` : `${f.name} could not be written to the place chosen. The browser reported: “${f.why}”`,
    `It has been downloaded instead: look in the browser's downloads folder.${f.unsaved ? ' The document here still counts as unsaved.' : ''}`,
    'The browser writes a temporary file beside the one being saved and swaps it in at the end. Security or file-sync software watching that folder can hold that file back, and a very long folder path can leave no room for its name. A short local path, such as a folder on the desktop, usually works.',
    ...(f.emptyLeft ? [`An empty file named ${f.name} may have been left at the place chosen: it is not the saved file, and can be deleted.`] : []),
  ];
}

/** Whether a folder holds a file of this name. */
export async function hasFile(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try { await dir.getFileHandle(name); return true; } catch (e) {
    if ((e as DOMException).name === 'NotFoundError' || (e as DOMException).name === 'TypeMismatchError') return (e as DOMException).name === 'TypeMismatchError';
    throw e;
  }
}

/** Write a file into a folder (made if missing): its handle. */
export async function writeInto(dir: FileSystemDirectoryHandle, name: string, bytes: Uint8Array): Promise<FileSystemFileHandle> {
  const fh = await dir.getFileHandle(name, { create: true });
  await writeHandle(fh, bytes);
  return fh;
}

/** Files opened from the OS via the PWA file handler. */
export function onLaunchFiles(cb: (files: PickedFile[]) => void): void {
  w.launchQueue?.setConsumer(async (p) => { if (p.files?.length) cb(await Promise.all(p.files.map((h) => fromHandle(h)))); });
  void handedOver().then(async (hs) => {
    const files: PickedFile[] = [];
    for (const h of hs) { try { files.push(await fromHandle(h)); } catch (e) { console.warn(`${h.name}: not handed over (${(e as Error).message})`); } }
    if (files.length) cb(files);
  });
}

/** The database the website's page hands files over in. */
export const LAUNCH_DB = 'konium-launch';
/**
 * Files handed over by the website's page: an app installed before Konium moved to app/ (26.169)
 * opens files at konium.app/ until the browser takes its new manifest; that page keeps the files'
 * handles in the browser's storage and goes on to the app, which opens them here (within a minute).
 */
async function handedOver(): Promise<FileSystemFileHandle[]> {
  if (typeof indexedDB === 'undefined' || !indexedDB.databases) return [];
  try { if (!(await indexedDB.databases()).some((d) => d.name === LAUNCH_DB)) return []; } catch { return []; }
  const kept = await new Promise<{ at: number; files: FileSystemFileHandle[] } | undefined>((res) => {
    const r = indexedDB.open(LAUNCH_DB);
    r.onerror = () => res(undefined);
    r.onsuccess = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('files')) { db.close(); res(undefined); return; }
      const g = db.transaction('files').objectStore('files').get('handles');
      g.onsuccess = () => { db.close(); res(g.result as { at: number; files: FileSystemFileHandle[] } | undefined); };
      g.onerror = () => { db.close(); res(undefined); };
    };
  });
  indexedDB.deleteDatabase(LAUNCH_DB);
  return kept && Array.isArray(kept.files) && Date.now() - kept.at < 60_000 ? kept.files : [];
}

/** File system handles from a drop (Chromium): lets a dropped folder or .PrjPcb open as a project. */
export async function handlesFromDrop(e: DragEvent): Promise<FileSystemHandle[]> {
  const items = [...(e.dataTransfer?.items ?? [])].filter((i) => i.kind === 'file');
  const get = (i: DataTransferItem) => (i as DataTransferItem & { getAsFileSystemHandle?(): Promise<FileSystemHandle | null> }).getAsFileSystemHandle?.();
  if (!items.length || !get(items[0]!)) return [];
  return (await Promise.all(items.map(get))).filter((h): h is FileSystemHandle => !!h);
}

export async function fileFromHandle(h: FileSystemFileHandle): Promise<PickedFile> { return fromHandle(h); }

export async function filesFromDrop(e: DragEvent): Promise<PickedFile[]> {
  const files = [...(e.dataTransfer?.files ?? [])];
  return Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
}

/** A small text file the user picks (settings, layouts): its name and contents, or null. */
export function pickTextFile(accept: string): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = async () => { const f = input.files?.[0]; resolve(f ? { name: f.name, text: await f.text() } : null); };
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}

/** One file the user picks, as bytes (templates, images), or null. */
export function pickFile(accept: string): Promise<PickedFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = async () => { const f = input.files?.[0]; resolve(f ? { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } : null); };
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}
