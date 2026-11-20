import { dbLibPcbLibraries } from './dbLib';
import { settings } from '../core/settings';
import { activeId, docs, notify, type Project } from './state';
import { activeProject, cmdCompile, whenMounted } from './project';
import { openDocument } from './actions';
import { showDialog } from './dialogs';
import { EcoDialog, type EcoChange } from './dialogs/Eco';
import { docBaseName } from '../formats/altium/prjpcb';
import { readPcbLib, type Footprint, type PcbLibrary } from '../formats/altium/pcblib';
import { footprintRecords, type FootprintEntry, type PcbLibDocument } from '../model/pcbLib';
import { isModelLibrary, itemChange, planPcbUpdate, validateItem, type FootprintFinder, type FoundFootprint } from '../model/pcbEco';
import type { Change } from '../core/undo';
import type { PcbDocument } from '../model/pcb';
import { installedPcbLibs } from './dialogs/PlacePart';
import { signal } from '@preact/signals';
import { pickTextFile, type PickedFile } from '../platform/fs';
import { active } from './state';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../editors/pcb/PcbLibEditor';
import { NETLIST_KINDS, readNetlistFile } from '../formats/netlistRead';
import { planNetlist } from '../model/netlistLoad';

/** PCB libraries picked by path (PCB Model › Library path › Choose...) this session: searched after the installed ones. */
export const pathPcbLibs = signal<PickedFile[]>([]);

/**
 * Design › Update PCB Document (from a schematic) and Design › Import Changes From <project>
 * (from the board): compile, compare with the board, and run the differences through an
 * Engineering Change Order. Footprints come from the project's .PcbLib libraries.
 */

const libCache = new WeakMap<Uint8Array, PcbLibrary>();
function projectLibraries(p: Project | null, withDbLibs = true): { name: string; footprints: Footprint[] }[] {
  const out: { name: string; footprints: Footprint[] }[] = [];
  // Data Management › File-based Libraries: the project's, the installed ones, or both
  const where = settings.libSearch;
  for (const path of where === 'installed' ? [] : p?.prj.documents ?? []) {
    const name = docBaseName(path);
    if (!/\.pcblib$/i.test(name)) continue;
    const f = p!.files.get(name.toLowerCase());
    if (!f) continue;
    let lib = libCache.get(f.bytes);
    if (!lib) { try { lib = readPcbLib(f.bytes, name); libCache.set(f.bytes, lib); } catch { continue; } }
    out.push(lib);
  }
  // …and the installed PCB libraries (directly, or from integrated libraries)
  for (const f of where === 'project' ? [] : [...installedPcbLibs.value, ...pathPcbLibs.value]) {
    let lib = libCache.get(f.bytes);
    if (!lib) { try { lib = readPcbLib(f.bytes, f.name); libCache.set(f.bytes, lib); } catch { continue; } }
    out.push(lib);
  }
  // …and those the database libraries in reach have read (the footprints their records name)
  if (withDbLibs) for (const lib of dbLibPcbLibraries()) if (!out.some((o) => o.name.toLowerCase() === lib.name.toLowerCase())) out.push(lib);
  return out;
}

/**
 * PCB libraries for the Libraries panel: those open for editing (as they are now, unsaved
 * changes included), then the project's and the installed ones not already listed.
 */
export function availablePcbLibraries(): { name: string; footprints: Footprint[] }[] {
  const out: { name: string; footprints: Footprint[] }[] = [];
  const seen = new Set<string>();
  for (const d of settings.libSearch === 'installed' ? [] : docs.value) {
    if (d.doc.kind !== 'PcbLib') continue;
    const lib = d.doc as PcbLibDocument;
    seen.add(d.name.toLowerCase());
    out.push({ name: d.name, footprints: lib.footprints.map((e) => (e.loaded === false && e.original && e.name === e.original.name ? e.original : entryFootprint(e))) });
  }
  // (not the database libraries' own: their parts list under their tables)
  for (const lib of projectLibraries(activeProject(), false)) if (!seen.has(lib.name.toLowerCase())) { seen.add(lib.name.toLowerCase()); out.push(lib); }
  return out;
}
const entryFootprint = (e: FootprintEntry): Footprint => {
  const f = { name: e.name, storage: e.storage ?? '', description: e.description, height: e.height } as Footprint;
  Object.defineProperty(f, 'records', { enumerable: true, get: () => footprintRecords(e.doc) });
  Object.defineProperty(f, 'prims', { enumerable: true, get: () => e.doc.prims });
  return f;
};

/** Every footprint in the project's PCB libraries, then the installed ones, library by library. */
export function projectFootprints(p: Project | null): FoundFootprint[] {
  return projectLibraries(p).flatMap((lib) => lib.footprints.map((footprint) => ({ library: lib.name, footprint })));
}

export function footprintFinder(p: Project | null): FootprintFinder {
  // First library wins, as Altium searches them in order; a model naming its library looks only there
  const libs = projectLibraries(p);
  const byName = new Map<string, FoundFootprint>();
  for (const lib of libs) for (const fp of lib.footprints) { const k = fp.name.toLowerCase(); if (!byName.has(k)) byName.set(k, { library: lib.name, footprint: fp }); }
  return (pattern, library) => {
    if (!library) return byName.get(pattern.toLowerCase());
    const lib = libs.find((l) => isModelLibrary(l.name, library));
    const fp = lib?.footprints.find((f) => f.name.toLowerCase() === pattern.toLowerCase());
    return lib && fp ? { library: lib.name, footprint: fp } : undefined;
  };
}

export function cmdUpdatePcb(): void {
  const p = activeProject();
  if (!p) { notify('Update PCB Document works on a PCB project: open the .PrjPcb', 'error'); return; }
  const res = cmdCompile();
  if (!res) return;
  const pcbName = p.prj.documents.map(docBaseName).find((n) => /\.pcbdoc$/i.test(n));
  if (!pcbName) { notify(`${p.name} has no PCB document`, 'error'); return; }
  let od = docs.value.find((d) => d.projectId === p.id && d.name.toLowerCase() === pcbName.toLowerCase());
  if (!od) {
    const f = p.files.get(pcbName.toLowerCase());
    if (!f) { notify(`${pcbName} isn't in the project folder`, 'error'); return; }
    od = openDocument(f, p.id, false) ?? undefined;
  }
  const ed = od?.editor;
  if (!od || !ed || od.doc.kind !== 'PcbDoc') { notify(`${pcbName} couldn't be opened`, 'error'); return; }
  const doc = od.doc as PcbDocument;
  const find = footprintFinder(p);
  const plan = planPcbUpdate(res.result, doc, find);
  let tx: { add(c: Change): void } | null = null;
  const changes: EcoChange[] = plan.map((it) => ({
    group: it.group, action: it.action, object: it.object, doc: od!.name, enabled: true,
    validate: () => validateItem(doc, it, plan, find),
    execute: () => { if (!tx) throw new Error('no transaction'); tx.add(itemChange(doc, it, find)); },
  }));
  const target = od;
  showDialog(EcoDialog, {
    title: 'Engineering Change Order', changes,
    transact: (run: () => void) => ed.undo.transact('Engineering Change Order', (t) => { tx = t; try { run(); } finally { tx = null; } }),
    onExecuted: () => { activeId.value = target.id; whenMounted(ed, () => ed.fitObjects()); },
  });
}

/** The netlist files Load a Netlist offers to pick: the usual names of the formats it reads. */
export const NETLIST_FILES = '.net,.NET,.asc,.tel,.txt,.edf,.edn,.edif,.edi,.pcad,.alg,.cir,.xml,*';

/**
 * Design › Netlist › Load a Netlist...: a netlist file (see formats/netlistRead) set against the board in front and its
 * differences run through an Engineering Change Order, as Update PCB Document runs a schematic's. Footprints come from the
 * board's project's libraries and the installed ones. `file`: the file already in hand (a script's, a test's).
 */
export async function cmdLoadNetlist(file?: { name: string; text: string }): Promise<void> {
  const ed = active.value?.editor, od = active.value;
  if (!od || !(ed instanceof PcbEditor) || ed instanceof PcbLibEditor) { notify('Load a Netlist works on a board: bring one in front', 'error'); return; }
  const picked = file ?? await pickTextFile(NETLIST_FILES);
  if (!picked) return;
  const netlist = readNetlistFile(picked.text);
  if (!netlist) { notify(`${picked.name} is not a netlist of a kind that is read: .NET, Tango, PADS, Telesis, KiCad, P-CAD, MultiWire or EDIF`, 'error'); return; }
  const kind = NETLIST_KINDS[netlist.format] ?? netlist.format;
  if (!netlist.parts.length && !netlist.nets.length) { notify(`${picked.name} (${kind}) names no parts and no nets`, 'error'); return; }
  const doc = od.doc as PcbDocument, find = footprintFinder(activeProject());
  const plan = planNetlist(netlist, doc, find);
  const said = `${picked.name} (${kind}): ${netlist.parts.length} part${netlist.parts.length === 1 ? '' : 's'} and ${netlist.nets.length} net${netlist.nets.length === 1 ? '' : 's'}`;
  if (!plan.length) { notify(`${said}. The board is as it says: nothing to change`, 'ok', 5000); return; }
  notify(`${said}${netlist.notes.length ? `; ${netlist.notes.join('; ')}` : ''}`, 'ok', netlist.notes.length ? 9000 : 5000);
  let tx: { add(c: Change): void } | null = null;
  const changes: EcoChange[] = plan.map((it) => ({
    group: it.group, action: it.action, object: it.object, doc: od.name, enabled: true,
    validate: () => validateItem(doc, it, plan, find),
    execute: () => { if (!tx) throw new Error('no transaction'); tx.add(itemChange(doc, it, find)); },
  }));
  showDialog(EcoDialog, {
    title: `Engineering Change Order: ${picked.name}`, changes,
    transact: (run: () => void) => ed.undo.transact(`Load ${picked.name}`, (t) => { tx = t; try { run(); } finally { tx = null; } }),
    onExecuted: () => { activeId.value = od.id; whenMounted(ed, () => ed.fitObjects()); },
  });
}
