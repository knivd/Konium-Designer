/**
 * Tools › Library Splitter Wizard: one library per component. Each comes from the original
 * file (header settings, fonts and other streams kept; untouched components keep their bytes),
 * holding only its own component; a footprint without 3D bodies leaves the shared models behind.
 */
import type { CfbEntry, CfbFile } from '../formats/cfb/cfb';
import { writeSchLib } from '../formats/altium/schlib';
import { PCB_TAG } from '../formats/altium/framing';
import { writePcbLib } from '../formats/altium/pcblib';
import { currentSymbols, writeSchLibDoc, type SchLibDocument } from './schLib';
import { footprintRecords, writePcbLibDoc, type FootprintEntry, type PcbLibDocument } from './pcbLib';

export interface SplitFile { name: string; bytes: Uint8Array }

/** A name a file system takes (Altium's references may hold / \ : …). */
export const fileSafe = (s: string) => s.replace(/[/\\:*?"<>|]/g, '_').trim() || 'Component';

const isComponentStorage = (c: CfbEntry) => c.kind === 'storage' && c.name !== 'Library' && c.children.some((x) => x.name === 'Data');
const only = (cfb: CfbFile, storage: string | undefined, root: (c: CfbEntry) => CfbEntry = (c) => c): CfbFile =>
  ({ ...cfb, root: { ...cfb.root, children: cfb.root.children.filter((c) => !isComponentStorage(c) || c.name === storage).map(root) } });

/** Unique file names: R1.SchLib, R1_2.SchLib … */
function namer(ext: string): (base: string) => string {
  const used = new Set<string>();
  return (base) => {
    let n = `${fileSafe(base)}${ext}`;
    for (let i = 2; used.has(n.toLowerCase()); i++) n = `${fileSafe(base)}_${i}${ext}`;
    used.add(n.toLowerCase());
    return n;
  };
}

export function splitSchLib(lib: SchLibDocument): SplitFile[] {
  const now = currentSymbols(lib), name = namer('.SchLib');
  return lib.symbols.map((o, i) => {
    const s = now[i]!;
    if (!lib.cfb) return { name: name(s.libRef), bytes: writeSchLib([s]) };
    const view = lib.views.get(o);
    const one: SchLibDocument = { ...lib, cfb: only(lib.cfb, o.storage), symbols: [o], views: view ? new Map([[o, view]]) : new Map() };
    return { name: name(s.libRef), bytes: writeSchLibDoc(one) };
  });
}

const hasBodies = (f: FootprintEntry) => (f.loaded === false && f.original ? f.original.records : footprintRecords(f.doc)).some((r) => r.tag === PCB_TAG.MODEL);

export function splitPcbLib(d: PcbLibDocument): SplitFile[] {
  const name = namer('.PcbLib');
  return d.footprints.map((f) => {
    if (!d.lib) return { name: name(f.name), bytes: writePcbLib([{ name: f.name, description: f.description, height: f.height, records: footprintRecords(f.doc) }]) };
    // The shared 3D models go only with a footprint that uses them
    const keepModels = hasBodies(f);
    const lib = { ...d.lib, cfb: only(d.lib.cfb, f.storage, (c) => (c.name === 'Library' && !keepModels ? { ...c, children: c.children.filter((x) => x.name !== 'Models') } : c)) };
    // A stand-in for the entry: saving notes storages on it, which mustn't touch the library being split
    const entry = Object.create(f) as FootprintEntry;
    return { name: name(f.name), bytes: writePcbLibDoc({ ...d, lib, footprints: [entry], removed: [] }) };
  });
}
