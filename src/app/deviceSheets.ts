/**
 * Preferences › Schematic › Device Sheets: folders of reusable sheets (device sheets). Place ›
 * Device Sheet Symbol lists their sheets; with Make Device Sheets Read-Only on, a device sheet
 * opened in Konium refuses edits. The folder names are remembered; their contents are read when
 * added (a browser grants folder access per session).
 */
import { signal } from '@preact/signals';
import { settings, updateSettings } from '../core/settings';
import { collectFromDirectory, hasFolderAccess, openFiles, type PickedFile } from '../platform/fs';
import { notify } from './state';

export interface DeviceFolder { name: string; files: PickedFile[] }
export const deviceFolders = signal<DeviceFolder[]>([]);

/** Every device sheet found in the folders this session. */
export const deviceSheetFiles = (): PickedFile[] => deviceFolders.value.flatMap((f) => f.files.filter((x) => /\.schdoc$/i.test(x.name)));
export const isDeviceSheet = (name: string): boolean => deviceSheetFiles().some((f) => f.name.toLowerCase() === name.toLowerCase());

export async function addDeviceFolder(): Promise<void> {
  let folder: DeviceFolder | null = null;
  if (hasFolderAccess()) {
    try {
      const dir = await (window as unknown as { showDirectoryPicker(o?: object): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ mode: 'read' });
      folder = { name: dir.name, files: (await collectFromDirectory(dir, 4)).filter((f) => /\.schdoc$/i.test(f.name)) };
    } catch (e) { if ((e as DOMException).name === 'AbortError') return; throw e; }
  } else {
    const files = (await openFiles()).filter((f) => /\.schdoc$/i.test(f.name));
    if (!files.length) return;
    folder = { name: `${files.length} sheet${files.length === 1 ? '' : 's'}`, files };
  }
  deviceFolders.value = [...deviceFolders.value.filter((f) => f.name !== folder!.name), folder];
  if (!settings.schDeviceFolders.includes(folder.name)) updateSettings({ schDeviceFolders: [...settings.schDeviceFolders, folder.name] });
  notify(`${folder.name}: ${folder.files.length} device sheet${folder.files.length === 1 ? '' : 's'}`);
}

export function removeDeviceFolder(name: string): void {
  deviceFolders.value = deviceFolders.value.filter((f) => f.name !== name);
  updateSettings({ schDeviceFolders: settings.schDeviceFolders.filter((n) => n !== name) });
}
