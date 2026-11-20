/**
 * Auto Save, recovery and Local History (Preferences › Data Management › Backup and Local
 * History; the Storage Manager panel).
 *
 * Auto Save: every so many minutes, and when the page is hidden or closed, each changed
 * document is copied into the browser (AD's Name.~(n).Ext copies, the oldest reused). Saving or
 * closing a document drops its copies; copies left by a session that ended (a crash, a tab
 * closed with work unsaved) are offered back when Konium next starts.
 *
 * Local History: each save first keeps the file it replaces — zipped as Name.~(n).Ext.Zip in a
 * History folder beside the project file (mirroring the project's sub-folders), as AD does
 * [est: the entry's name in the zip], or in the browser when the project has no folder access,
 * the document is outside the project's folder, or Use global repository is on. Versions older
 * than the days kept go when a new one is written; labelled ones stay.
 */
import { signal } from '@preact/signals';
import { canSave, save } from '../formats/registry';
import { unzipEntries } from '../formats/xlsxRead';
import { zipDeflated } from '../formats/zip';
import { settings } from '../core/settings';
import { copyToBackupFolder } from './dataManagement';
import { autoSaveLabel, backupName, docKeyOf, expired, historyZipName, nextSlot, nextVersion, parseHistoryZip, purgeSelection, sessionGone, versionTitle } from '../model/historyNames';
import {
  adoptAutoCopies, autoCopyBytes, backupAvailable, dropAutoCopies, dropStoredVersions, folderLabels, listAutoCopies, listStoredVersions, putAutoCopy, putStoredVersion,
  setFolderLabel, setStoredLabel, storedVersionBytes, type AutoCopy,
} from '../platform/backupStore';
import { docs, FLAGGED_KINDS, isDocDirty, notify, projects, type OpenDoc, type Project } from './state';

/* ── this session ── */

export const SESSION = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const BEATS = 'konium.sessions';
function beats(): Record<string, number> { try { return JSON.parse(localStorage.getItem(BEATS) ?? '{}') as Record<string, number>; } catch { return {}; } }
function beat(gone = false): void {
  try {
    const now = Date.now(), b = beats();
    // (sessions silent for a day are forgotten)
    for (const [k, t] of Object.entries(b)) if (now - t > 86_400_000) delete b[k];
    if (gone) delete b[SESSION]; else b[SESSION] = now;
    localStorage.setItem(BEATS, JSON.stringify(b));
  } catch { /* no storage */ }
}

/** Bumped when copies or history change (the Storage Manager and the Home page redraw). */
export const backupTick = signal(0);
const changed = () => { backupTick.value++; };

/* ── documents and their identity ── */

export interface FileRef { name: string; project?: Project; path?: string; od?: OpenDoc; handle?: FileSystemFileHandle }
export const refOf = (od: OpenDoc): FileRef => ({ name: od.name, project: projects.value.find((p) => p.id === od.projectId), path: od.path, od, handle: od.handle });
export const keyOf = (f: FileRef): string => docKeyOf(f.project?.name, f.path, f.name);

/** A document's bytes as it stands (as Save writes it). */
function bytesOf(od: OpenDoc): Uint8Array | null {
  if (!canSave(od.doc)) return null;
  try { return od.editor ? od.editor.withToolSuspended(() => save(od.doc)) : save(od.doc); } catch { return null; }
}

/**
 * The browser would not keep something (its storage full or switched off): said once in a
 * session for each kind, since otherwise Auto Save and Local History look on while keeping nothing.
 */
const told = new Set<string>();
export function refused(what: string, name: string): void {
  if (!backupAvailable() || told.has(what)) return;
  told.add(what);
  notify(`${what} ${name}: the browser refused it (its storage for this site may be full, or switched off). Nothing is being kept until that is put right: View › Workspace Panels › System › Storage Manager shows what is there.`, 'error');
}

/* ── Auto Save ── */

const snapped = new WeakMap<OpenDoc, number | string>();
/** A button held in the window (an edit being dragged): its documents' copies wait; a press with no release seen for 5 s no longer counts. */
let downAt = 0;
const dragging = () => downAt > 0 && Date.now() - downAt < 5000;
/** What tells a document has changed since its last copy: its undo revision, or (documents without an editor) its size and first bytes. */
const markOf = (od: OpenDoc, b?: Uint8Array | null): number | string => (od.editor ? od.editor.undo.revision : b ? `${b.length}:${b.subarray(0, 64).join(',')}:${b.subarray(-64).join(',')}` : '');

/** Copy every changed document into the browser now. */
/** Why each document was or wasn't copied the last time (for the tests). */
export const lastAutoSave: string[] = [];
export async function autoSaveNow(): Promise<number> {
  let n = 0;
  lastAutoSave.length = 0;
  for (const od of docs.value) {
    const why = (w: string) => { lastAutoSave.push(`${od.name}: ${w}`); };
    if (!isDocDirty(od)) { why('unchanged'); continue; }
    if (od.editor && dragging()) { why('a button held'); continue; }
    if (od.editor && snapped.get(od) === od.editor.undo.revision) { why('copied at this revision'); continue; }
    const bytes = bytesOf(od);
    if (!bytes) { why('not savable'); continue; }
    const mark = markOf(od, bytes);
    if (!od.editor && snapped.get(od) === mark) { why('copied as it is'); continue; }
    const f = refOf(od), docKey = keyOf(f);
    const used = (await listAutoCopies()).filter((c) => c.docKey === docKey && c.session === SESSION);
    const slot = nextSlot(used, settings.autoSaveVersions);
    const at = Date.now();
    const ok = await putAutoCopy({ key: `${docKey}#${SESSION}#${slot}`, docKey, slot, name: od.name, project: f.project?.name, path: f.path, session: SESSION, at, size: bytes.length }, bytes);
    // (fewer versions kept than before: the extra slots go)
    const extra = used.filter((c) => c.slot > settings.autoSaveVersions).map((c) => c.key);
    if (extra.length) await dropAutoCopies({ keys: extra });
    if (ok) { snapped.set(od, mark); n++; why(`copied to slot ${slot}`); } else { why('the browser refused the copy'); refused('Auto Save could not keep a copy of', od.name); }
    // Backup › Path: into the folder chosen too
    if (ok && settings.backupFolder && (await copyToBackupFolder(od.name, slot, bytes))) why(`and to ${settings.backupFolder}`);
    if (ok && settings.historyAutosaves) await keepVersion(f, bytes, autoSaveLabel(new Date(at))).catch(() => undefined);
  }
  if (n) changed();
  return n;
}

/** A document saved or closed without saving: its copies go. */
export function dropCopiesOf(od: OpenDoc): void { snapped.delete(od); void dropAutoCopies({ docKey: keyOf(refOf(od)), session: SESSION }).then(changed); }

/** Copies offered back at the start (the Home page lists them until opened or discarded). */
export const recovery = signal<AutoCopy[]>([]);
export async function refreshRecovery(): Promise<void> { recovery.value = await recoverable(); }

/** Copies left by sessions that ended (offered back), newest first. */
export async function recoverable(): Promise<AutoCopy[]> {
  const b = beats(), now = Date.now();
  const all = (await listAutoCopies()).filter((c) => c.session !== SESSION && sessionGone(b, c.session, now));
  // One per document: its newest copy
  const best = new Map<string, AutoCopy>();
  for (const c of all) { const was = best.get(c.docKey); if (!was || c.at > was.at) best.set(c.docKey, c); }
  return [...best.values()].sort((a, b2) => b2.at - a.at);
}

/** Recovered copies opened as unsaved documents (into their project when it's open). */
export async function recoverCopies(list: AutoCopy[]): Promise<number> {
  const { openDocument } = await import('./actions');
  let n = 0;
  const missed: string[] = [];
  for (const c of list) {
    const bytes = await autoCopyBytes(c.key);
    if (!bytes) { missed.push(c.name); continue; }
    const p = c.project ? projects.value.find((x) => x.name.toLowerCase() === c.project!.toLowerCase()) : undefined;
    // A document of that name open already (in its project, or on its own): the copy opens beside it under a name of its own
    const taken = (n: string, projectId: string | undefined) => docs.value.some((d) => d.projectId === projectId && d.name.toLowerCase() === n.toLowerCase());
    let name = c.name;
    if (taken(name, p?.id)) { name = `[Recovered] ${c.name}`; for (let k = 2; taken(name, undefined); k++) name = `[Recovered ${k}] ${c.name}`; }
    const before = new Set(docs.value);
    const od = openDocument({ name, bytes, path: name === c.name ? c.path : undefined }, name === c.name ? p?.id : undefined);
    // Only a document made from these very bytes counts: anything else, and the copy stays where it is, still offered
    if (!od || before.has(od)) { missed.push(c.name); continue; }
    od.editor?.undo.markUnsaved();
    if (FLAGGED_KINDS.has(od.doc.kind)) (od.doc as { dirty?: boolean }).dirty = true;
    // The document's copies are this session's now (kept until it's saved or closed)
    const all = (await listAutoCopies()).filter((x) => x.docKey === c.docKey);
    await adoptAutoCopies(all.map((x) => x.key), SESSION);
    n++;
  }
  docs.value = [...docs.value];
  changed();
  await refreshRecovery();
  if (missed.length) notify(`Not opened: ${missed.join(', ')}. ${missed.length === 1 ? 'Its copy' : 'Their copies'} could not be read or opened${recovery.value.length ? '; what is still listed is still kept' : ''}.`, 'error');
  return n;
}
export async function discardCopies(list: AutoCopy[]): Promise<void> {
  const all = await listAutoCopies();
  await dropAutoCopies({ keys: all.filter((x) => list.some((c) => c.docKey === x.docKey) && x.session !== SESSION).map((x) => x.key) });
  changed();
  await refreshRecovery();
}

/** Copies of a document (Storage Manager › Show Autobackups), newest first. */
export async function copiesOf(f: FileRef): Promise<AutoCopy[]> {
  const k = keyOf(f);
  return (await listAutoCopies()).filter((c) => c.docKey === k).sort((a, b) => b.at - a.at);
}
export { autoCopyBytes, backupName };

/**
 * Auto Save running: the timer, the page hidden or closed, this session's heartbeat (so other
 * tabs don't take its copies for a crashed session's). Returns what stops it.
 */
export function startBackup(): () => void {
  beat();
  let last = Date.now();
  const tick = () => {
    beat();
    if (settings.autoSave && Date.now() - last >= settings.autoSaveMinutes * 60_000) { last = Date.now(); void autoSaveNow(); }
  };
  const every = setInterval(tick, 20_000);
  const hidden = () => { if (document.visibilityState === 'hidden' && settings.autoSave) void autoSaveNow(); };
  const leaving = () => { if (settings.autoSave) void autoSaveNow(); beat(true); };
  const down = () => { downAt = Date.now(); }, up = () => { downAt = 0; };
  document.addEventListener('visibilitychange', hidden);
  window.addEventListener('pagehide', leaving);
  window.addEventListener('pointerdown', down, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
  window.addEventListener('blur', up);
  return () => {
    clearInterval(every);
    document.removeEventListener('visibilitychange', hidden);
    window.removeEventListener('pagehide', leaving);
    window.removeEventListener('pointerdown', down, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', up, true);
    window.removeEventListener('blur', up);
    beat(true);
  };
}

/* ── Local History ── */

export interface Version {
  n: number; at: number; size: number; label?: string;
  /** Where it's kept: the project's History folder or the browser. */
  where: 'folder' | 'browser';
  /** Its file in the History folder, or its key in the browser. */
  id: string;
}

/** The folder a project's documents' paths start from (beside the .PrjPcb). */
async function projectDir(p: Project): Promise<FileSystemDirectoryHandle | null> {
  if (!p.dir) return null;
  const { projectFolder } = await import('./actions');
  return projectFolder(p).catch(() => null);
}
const granted = async (h: FileSystemHandle, ask: boolean): Promise<boolean> => {
  const hh = h as FileSystemHandle & { queryPermission?(o: unknown): Promise<string>; requestPermission?(o: unknown): Promise<string> };
  if (!hh.queryPermission) return true;
  if ((await hh.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  return ask && (await hh.requestPermission?.({ mode: 'readwrite' })) === 'granted';
};

/** Where a file's history lives: its sub-folder of the project's History folder, or null (the browser). */
async function historyHome(f: FileRef, create: boolean, ask = false): Promise<FileSystemDirectoryHandle | null> {
  if (settings.historyGlobal || !f.project?.dir || !f.handle) return null;
  const root = await projectDir(f.project);
  if (!root || !(await granted(root, ask))) return null;
  const rel = await root.resolve(f.handle).catch(() => null);
  if (!rel) return null;
  try {
    let d = await root.getDirectoryHandle('History', { create });
    for (const seg of rel.slice(0, -1)) d = await d.getDirectoryHandle(seg, { create });
    return d;
  } catch { return null; }
}

/** A file's versions, newest first (both places, should it have moved between them). */
export async function versionsOf(f: FileRef): Promise<Version[]> {
  const k = keyOf(f), out: Version[] = [];
  const dir = await historyHome(f, false);
  if (dir) {
    const labels = await folderLabels(k);
    for await (const [file, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      const v = h.kind === 'file' ? parseHistoryZip(file) : null;
      if (!v || v.name.toLowerCase() !== f.name.toLowerCase()) continue;
      const fl = await (h as FileSystemFileHandle).getFile();
      out.push({ n: v.n, at: fl.lastModified, size: fl.size, label: labels.get(v.n), where: 'folder', id: file });
    }
  }
  for (const v of await listStoredVersions(k)) out.push({ n: v.n, at: v.at, size: v.size, label: v.label, where: 'browser', id: v.key });
  return out.sort((a, b) => b.n - a.n || b.at - a.at);
}

/** A version's file. */
export async function versionBytes(f: FileRef, v: Version): Promise<Uint8Array | null> {
  if (v.where === 'browser') return storedVersionBytes(v.id);
  const dir = await historyHome(f, false);
  if (!dir) return null;
  const zipped = new Uint8Array(await (await (await dir.getFileHandle(v.id)).getFile()).arrayBuffer());
  const e = unzipEntries(zipped)[0];
  return e ? e.data() : null;
}

/** Keep a version of a file (Save keeps the one it replaces; Auto Save, with the option, its copy). */
async function keepVersion(f: FileRef, bytes: Uint8Array, label?: string, ask = false): Promise<void> {
  const k = keyOf(f);
  const have = await versionsOf(f);
  // (the same as the newest: nothing new to keep)
  const newest = have[0];
  if (newest && newest.size !== 0) { const b = await versionBytes(f, newest).catch(() => null); if (b && b.length === bytes.length && b.every((x, i) => x === bytes[i])) return; }
  const n = nextVersion(have.map((v) => v.n));
  const dir = await historyHome(f, true, ask);
  if (dir) {
    const fh = await dir.getFileHandle(historyZipName(f.name, n), { create: true });
    const w = await fh.createWritable();
    await w.write(await zipDeflated([{ name: f.name, bytes }]) as unknown as BufferSource);
    await w.close();
    if (label) await setFolderLabel(k, n, label);
  } else if (!(await putStoredVersion({ key: `${k}#${n}`, docKey: k, n, name: f.name, at: Date.now(), size: bytes.length, label }, bytes))) refused('Local History could not keep a version of', f.name);
  // Older than the days kept: gone (labelled ones stay)
  const old = expired(await versionsOf(f), settings.historyDays);
  if (old.length) await deleteVersions(f, old);
  changed();
}

/**
 * Before a save overwrites a file: keep what it replaces — read from the file itself when there
 * is one (what's on disk, even if changed elsewhere), else the bytes it was last saved or opened as.
 */
export async function keepPrevious(f: FileRef, fallback: Uint8Array | undefined): Promise<void> {
  try {
    let prev: Uint8Array | undefined;
    if (f.handle) prev = await f.handle.getFile().then(async (x) => new Uint8Array(await x.arrayBuffer())).catch(() => undefined);
    prev ??= fallback;
    if (prev && prev.length) await keepVersion(f, prev, undefined, true);
  } catch { /* history is a convenience: the save goes ahead */ }
}

export async function deleteVersions(f: FileRef, vs: Version[]): Promise<void> {
  const k = keyOf(f);
  const dir = vs.some((v) => v.where === 'folder') ? await historyHome(f, false) : null;
  for (const v of vs) {
    if (v.where === 'browser') continue;
    await dir?.removeEntry(v.id).catch(() => undefined);
    if (v.label) await setFolderLabel(k, v.n, undefined);
  }
  await dropStoredVersions(vs.filter((v) => v.where === 'browser').map((v) => v.id));
  changed();
}

export async function labelVersion(f: FileRef, v: Version, label: string | undefined): Promise<void> {
  const l = label?.trim().slice(0, 64) || undefined;
  if (v.where === 'browser') await setStoredLabel(v.id, l); else await setFolderLabel(keyOf(f), v.n, l);
  changed();
}

/** Storage Manager › Purge History: the versions it took away. */
export async function purgeHistory(f: FileRef, o: { days?: number; keep?: number; labelled?: boolean }): Promise<number> {
  const go = purgeSelection(await versionsOf(f), o);
  if (go.length) await deleteVersions(f, go);
  return go.length;
}

export { versionTitle };

/** Open a version as a document of its own ([Version n] Name), read from its history. */
export async function openVersion(f: FileRef, v: Version): Promise<void> {
  const bytes = await versionBytes(f, v);
  if (!bytes) { notify(`${versionTitle(v.n)} of ${f.name} couldn't be read`, 'error'); return; }
  const { openDocument } = await import('./actions');
  openDocument({ name: `[Version ${v.n}] ${f.name}`, bytes });
}

/**
 * Revert to a version: the file becomes it, byte for byte (the file it replaces kept in history
 * as a new version, so a revert can be reverted) and the document is opened again from it; a
 * document with no file becomes it as unsaved changes. An open document's unsaved changes are
 * kept in history first.
 */
export async function revertTo(f: FileRef, bytes: Uint8Array): Promise<boolean> {
  const { openDocument, cmdClose } = await import('./actions');
  const { ensurePermission } = await import('../platform/fs');
  const od = f.od && docs.value.includes(f.od) ? f.od : undefined;
  if (od && isDocDirty(od)) { const now = bytesOf(od); if (now) await keepVersion(f, now, 'Unsaved changes before revert').catch(() => undefined); }
  let written = false;
  if (f.handle && (await ensurePermission(f.handle).catch(() => false))) {
    await keepPrevious(f, undefined);
    const w = await f.handle.createWritable();
    await w.write(bytes as unknown as BufferSource);
    await w.close();
    written = true;
  }
  if (od) await cmdClose(od, false);
  if (f.project) f.project.files.set(f.name.toLowerCase(), { name: f.name, bytes, handle: f.handle, path: f.path });
  // (a file that wasn't open stays closed)
  if (!od && written) { changed(); return true; }
  const fresh = openDocument({ name: f.name, bytes, handle: f.handle, path: f.path }, f.project?.id, true);
  if (!fresh) return false;
  if (!written) fresh.editor?.undo.markUnsaved();
  changed();
  return true;
}
