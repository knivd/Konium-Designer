/**
 * Preferences › Data Management, the parts that keep files:
 * - Templates: the sheet template new schematics start from (Use templates for new documents),
 *   chosen once and kept in the browser;
 * - Backup › Path: a folder auto save's copies are also written to (Name.~(n).SchDoc), its
 *   handle kept in the browser so the next session needs one "Allow".
 */
import { settings, updateSettings } from '../core/settings';
import { readLocal, writeLocal } from '../core/storage';
import { readSchDoc } from '../formats/altium/schdoc';
import { applyTemplateChanges } from '../model/schTemplate';
import type { SchDocument } from '../model/sch';
import { hasFolderAccess, pickFile } from '../platform/fs';
import { dropHandle, getHandle, putHandle } from '../platform/handleStore';
import { backupName } from '../model/historyNames';
import { notify } from './state';

const TPL_KEY = 'template.sch.v1';
const b64 = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Templates › Template: a .SchDot (or .SchDoc) chosen, kept in the browser. */
export async function chooseTemplate(): Promise<void> {
  const f = await pickFile('.SchDot,.SchDoc');
  if (!f) return;
  try { readSchDoc(f.bytes, f.name); } catch (e) { notify(`${f.name}: ${(e as Error).message}`, 'error'); return; }
  try { writeLocal(TPL_KEY, JSON.stringify({ name: f.name, data: b64(f.bytes) })); } catch { notify(`${f.name} is too big to keep in the browser`, 'error'); return; }
  updateSettings({ templateName: f.name, useTemplates: true });
  notify(`New schematics start from ${f.name}`);
}

/** The template new schematics start from (null: none, or Use templates off). */
export function sheetTemplate(): { name: string; doc: SchDocument } | null {
  if (!settings.useTemplates || !settings.templateName) return null;
  try {
    const t = JSON.parse(readLocal(TPL_KEY) ?? 'null') as { name: string; data: string } | null;
    return t ? { name: t.name, doc: readSchDoc(unb64(t.data), t.name) } : null;
  } catch { return null; }
}

/** A new schematic, its template applied (part of it from the start, not an undo step). */
export function withTemplate(doc: SchDocument): SchDocument {
  const t = sheetTemplate();
  if (t) for (const c of applyTemplateChanges(doc, t.doc, t.name)) c.apply();
  return doc;
}

/** Backup › Path: a folder for auto save's copies too. */
export async function chooseBackupFolder(): Promise<void> {
  if (!hasFolderAccess()) { notify('This browser can\'t write to a folder of its own choosing: the copies stay in the browser', 'error'); return; }
  try {
    const dir = await (globalThis as unknown as { showDirectoryPicker(o: unknown): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ id: 'konium-backup', mode: 'readwrite' });
    await putHandle('backup', dir);
    updateSettings({ backupFolder: dir.name });
    notify(`Auto save copies also go to ${dir.name}`);
  } catch (e) { if ((e as DOMException).name !== 'AbortError') notify(`No folder: ${(e as Error).message}`, 'error'); }
}
export async function clearBackupFolder(): Promise<void> { await dropHandle('backup'); updateSettings({ backupFolder: '' }); }

/** Write an auto save copy into the backup folder too (when one is chosen and still allowed). */
export async function copyToBackupFolder(name: string, slot: number, bytes: Uint8Array): Promise<boolean> {
  if (!settings.backupFolder) return false;
  const dir = await getHandle<FileSystemDirectoryHandle>('backup');
  if (!dir) return false;
  try {
    const st = await (dir as unknown as { queryPermission?(o: { mode: string }): Promise<string> }).queryPermission?.({ mode: 'readwrite' });
    if (st && st !== 'granted') return false;
    const fh = await dir.getFileHandle(backupName(name, slot), { create: true });
    const w = await fh.createWritable();
    await w.write(bytes as Uint8Array<ArrayBuffer>);
    await w.close();
    return true;
  } catch { return false; }
}
