/**
 * The parts shelf (R21): the parts kept in this browser, and their two libraries (My Parts.SchLib,
 * My Parts.PcbLib) kept among the installed ones for as long as the shelf holds anything, so a
 * part is placed, browsed and found for a board like any library's.
 */
import { effect, signal } from '@preact/signals';
import { installedLibs, installedPcbLibs } from './dialogs/PlacePart';
import { SHELF_PCB, SHELF_SCH, partKey, shelfLibraries, type PartPackage } from '../model/partPackage';
import { dropPart, loadParts, storePart } from '../platform/partStore';
import { tick } from './state';

export const shelf = signal<PartPackage[]>([]);
const sorted = (l: PartPackage[]) => [...l].sort((a, b) => a.record.mpn.localeCompare(b.record.mpn, 'en', { numeric: true, sensitivity: 'base' }));
export const shelfPart = (mpn: string): PartPackage | null => { const k = partKey(mpn); return (k && shelf.value.find((p) => partKey(p.record.mpn) === k)) || null; };

let started = false;
/** At start-up: the parts kept in earlier sessions come back; from then on the shelf's libraries follow it. */
export async function restoreShelf(): Promise<void> {
  if (started) return;
  started = true;
  const kept = await loadParts();
  // (a part kept during the load stays)
  shelf.value = sorted([...kept.filter((p) => !shelfPart(p.record.mpn)), ...shelf.value]);
  effect(() => {
    const parts = shelf.value;
    const sch = installedLibs.peek().filter((f) => f.name !== SHELF_SCH), pcb = installedPcbLibs.peek().filter((f) => f.name !== SHELF_PCB);
    if (!parts.length) {
      if (sch.length !== installedLibs.peek().length) installedLibs.value = sch;
      if (pcb.length !== installedPcbLibs.peek().length) installedPcbLibs.value = pcb;
      return;
    }
    const libs = shelfLibraries(parts);
    installedLibs.value = [...sch, { name: SHELF_SCH, bytes: libs.schlib }];
    installedPcbLibs.value = [...pcb, { name: SHELF_PCB, bytes: libs.pcblib }];
    // (written without being read here: the shelf's libraries don't follow the redraw counter)
    tick.value = tick.peek() + 1;
  });
}

/** A part put on the shelf (one of its number there already is replaced). True when it replaced one. */
export function keepPart(p: PartPackage): boolean {
  const had = !!shelfPart(p.record.mpn);
  shelf.value = sorted([...shelf.value.filter((x) => partKey(x.record.mpn) !== partKey(p.record.mpn)), p]);
  void storePart(p).catch(() => { /* a browser that keeps nothing: the part stays for the session */ });
  return had;
}
export function removePart(mpn: string): void {
  shelf.value = shelf.value.filter((x) => partKey(x.record.mpn) !== partKey(mpn));
  void dropPart(mpn).catch(() => { /* nothing kept */ });
}
