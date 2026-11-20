import { effect } from '@preact/signals';
import { installedLibs, installedPcbLibs } from './dialogs/PlacePart';
import { loadLibs, syncLibs, type StoredKind } from '../platform/libStore';
import { installedDbLibs, type InstalledDbLib } from './dbLib';
import type { PickedFile } from '../platform/fs';
import { tick } from './state';
import { SHELF_PCB, SHELF_SCH } from '../model/partPackage';

let started = false;
let chain: Promise<void> = Promise.resolve();

/**
 * At start-up: the libraries installed in earlier sessions come back; from then on every
 * Install, Remove or reorder is kept.
 */
export async function restoreInstalledLibraries(): Promise<void> {
  if (started) return;
  started = true;
  const rows = await loadLibs();
  const sch = rows.filter((r) => r.kind === 'sch').map((r) => ({ name: r.name, bytes: r.bytes }));
  const pcb = rows.filter((r) => r.kind === 'pcb').map((r) => ({ name: r.name, bytes: r.bytes }));
  // Installed during the load (an Install click before it finished) stays too
  installedLibs.value = [...sch.filter((f) => !installedLibs.value.some((g) => g.name === f.name)), ...installedLibs.value];
  installedPcbLibs.value = [...pcb.filter((f) => !installedPcbLibs.value.some((g) => g.name === f.name)), ...installedPcbLibs.value];
  // Database libraries, each with the files kept with it ("<library>|<path>"; "<library>|@" holds where it sits among them)
  const dbs: InstalledDbLib[] = rows.filter((r) => r.kind === 'dblib').map((r) => {
    const own = rows.filter((x) => x.kind === 'dbfile' && x.name.toLowerCase().startsWith(`${r.name.toLowerCase()}|`));
    const at = own.find((x) => x.name.endsWith('|@'));
    const files = new Map<string, PickedFile>();
    for (const x of own) if (x !== at) { const path = x.name.slice(r.name.length + 1); files.set(path.toLowerCase(), { name: path.split('/').pop() ?? path, bytes: x.bytes, path }); }
    return { name: r.name, bytes: r.bytes, folder: { files, at: at ? new TextDecoder().decode(at.bytes) : r.name.toLowerCase() } };
  });
  installedDbLibs.value = [...dbs.filter((d) => !installedDbLibs.value.some((g) => g.name === d.name)), ...installedDbLibs.value];
  if (rows.length) tick.value++;
  effect(() => {
    const list: { name: string; kind: StoredKind; bytes: Uint8Array }[] = [...installedLibs.value.filter((f) => f.name !== SHELF_SCH).map((f) => ({ name: f.name, kind: 'sch' as const, bytes: f.bytes })), ...installedPcbLibs.value.filter((f) => f.name !== SHELF_PCB).map((f) => ({ name: f.name, kind: 'pcb' as const, bytes: f.bytes }))];
    for (const d of installedDbLibs.value) {
      list.push({ name: d.name, kind: 'dblib', bytes: d.bytes }, { name: `${d.name}|@`, kind: 'dbfile', bytes: new TextEncoder().encode(d.folder.at) });
      for (const [path, f] of d.folder.files) list.push({ name: `${d.name}|${f.path ?? path}`, kind: 'dbfile', bytes: f.bytes });
    }
    chain = chain.then(() => syncLibs(list));
  });
}
