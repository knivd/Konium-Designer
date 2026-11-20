/**
 * EAGLE's files into AD projects (EAGLE 6 and later, and Fusion Electronics' EAGLE exports, all
 * XML): a schematic and a board of one name in one folder are one project (its sheets, the SchLib
 * of its devices, the board and the PcbLib of its packages), a lone schematic or board a project of
 * its own, a library (.lbr) a SchLib of its devices and a PcbLib of its packages. EAGLE joins nets by
 * name on every sheet: the projects' Net Identifier Scope is Global. EAGLE's own consistency of
 * schematic and board is checked on the way (pins on other nets, parts missing from either).
 * EAGLE before 6 kept binary files: those are named, not read. Each board and schematic keeps the file it
 * came from (kept.ts): exported back to EAGLE unchanged, it is that file byte for byte; a board changed
 * only by parts moved and nets rerouted, that file with those spliced in (splice.ts).
 */
import { addDocument, iniSet, newPrjPcb, writePrjPcb } from '../altium/prjpcb';
import { ipcFootprintLibrary } from '../ipc2581read';
import type { ImportedDoc, ImportFile, ImportItem, ImportOptions, ImportResult } from '../importers';
import { isEagleXml, readEagle, type EagleDoc, type ELib } from './read';
import { convertEagleSch, eagleSchNetlist, eagleSymbolLibrary, footprintNames, deviceName, type LibEntry } from './sch';
import { convertEagleBrd, eagleFootprintLibrary } from './brd';
import { kid, kidsOf } from '../xml';
import { readSchDoc } from '../altium/schdoc';
import { keepBrd, keepSch } from './kept';
import { compileProject } from '../../model/compile';
import { breathe } from '../../core/breathe';

const td = new TextDecoder();
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const stemOf = (p: string) => baseName(p).replace(/\.[^.]+$/, '');
const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_').trim() || 'EAGLE';
const yieldNow = breathe;
const EXT = /\.(sch|brd|lbr)$/i;

/** Whether the importer takes a file: EAGLE's XML (by its first bytes), or its old binary files by name and signature. */
export function takesEagle(name: string, head: string): boolean {
  if (!EXT.test(name)) return false;
  if (isEagleXml(head)) return true;
  // EAGLE 5's binary files: 0x10 then 0x00 or 0x80 (decoded, U+FFFD); not Allegro's .brd (its version word)
  const binary = head.charCodeAt(0) === 0x10 && (head.charCodeAt(1) === 0 || head.charCodeAt(1) === 0xfffd);
  return binary && !(head.charCodeAt(3) === 0 && head.charCodeAt(2) >= 0x0f && head.charCodeAt(2) <= 0x16);
}

const kindOf = (path: string, bytes?: Uint8Array): string => {
  const ext = /\.(\w+)$/.exec(path)?.[1]?.toLowerCase();
  if (bytes && !isEagleXml(td.decode(bytes.subarray(0, 4096)))) return 'EAGLE 5 or earlier (binary)';
  return ext === 'sch' ? 'Schematic' : ext === 'brd' ? 'PCB' : 'Library';
};
export function listEagle(files: { path: string; bytes?: Uint8Array }[]): ImportItem[] {
  return files.filter((f) => EXT.test(f.path) && (!f.bytes || takesEagle(f.path, td.decode(f.bytes.subarray(0, 4096))))).map((f) => {
    const kind = kindOf(f.path, f.bytes);
    return { path: f.path, kind, ...(kind.startsWith('EAGLE 5') ? { note: 'open and save it in EAGLE 6 or later first' } : {}) };
  });
}

/** Schematic and board against each other, as EAGLE's forward and back annotation keeps them: pins on other nets, parts on one side only. */
export function eagleConsistency(sch: EagleDoc, brd: EagleDoc): string[] {
  const out: string[] = [];
  const schNet = new Map<string, string>();
  for (const [n, pins] of eagleSchNetlist(sch)) for (const p of pins) schNet.set(p, n);
  const brdNet = new Map<string, string>();
  for (const s of kidsOf(kid(brd.board, 'signals'), 'signal')) for (const c of kidsOf(s, 'contactref')) brdNet.set(`${c.attrs.element ?? ''}.${c.attrs.pad ?? ''}`, s.attrs.name ?? '');
  const elements = new Set(kidsOf(kid(brd.board, 'elements'), 'element').map((e) => e.attrs.name ?? ''));
  const parts = kidsOf(kid(sch.schematic, 'parts'), 'part').filter((p) => p.attrs.package || hasPackage(sch, p.attrs.library ?? '', p.attrs.library_urn ?? '', p.attrs.deviceset ?? '', p.attrs.device ?? ''));
  const partNames = new Set(parts.map((p) => p.attrs.name ?? ''));
  const onlySch = [...partNames].filter((p) => !elements.has(p)), onlyBrd = [...elements].filter((e) => !partNames.has(e));
  if (onlySch.length) out.push(`Parts on the schematic and not the board: ${onlySch.slice(0, 8).join(', ')}${onlySch.length > 8 ? ` and ${onlySch.length - 8} more` : ''}`);
  if (onlyBrd.length) out.push(`Elements on the board and not the schematic: ${onlyBrd.slice(0, 8).join(', ')}${onlyBrd.length > 8 ? ` and ${onlyBrd.length - 8} more` : ''}`);
  // A pin's net: the schematic's and the board's names may differ, the groups may not
  const pairOf = new Map<string, string>();
  const bad: string[] = [];
  for (const [pin, n] of schNet) {
    const b = brdNet.get(pin);
    if (b === undefined) { if (elements.has(pin.split('.')[0]!)) bad.push(pin); continue; }
    const k = pairOf.get(n);
    if (k === undefined) pairOf.set(n, b); else if (k !== b) bad.push(pin);
  }
  for (const [pin] of brdNet) if (!schNet.has(pin) && partNames.has(pin.split('.')[0]!)) bad.push(pin);
  if (bad.length) out.push(`Schematic and board disagree on ${bad.length} pin${bad.length === 1 ? '' : 's'}' nets (${bad.slice(0, 6).join(', ')}${bad.length > 6 ? ' …' : ''}): EAGLE's annotation was broken; each document comes in as it is`);
  return out;
}
function hasPackage(doc: EagleDoc, lib: string, urn: string, ds: string, dev: string): boolean {
  return !!doc.lib(lib, urn)?.devicesets.get(ds)?.devices.get(dev)?.pkg;
}

/** A library's devices and packages: its SchLib (each device a symbol) and PcbLib. */
export function eagleLibraries(doc: EagleDoc, name: string): { schLib?: ImportedDoc; pcbLib?: ImportedDoc; symbols: number; footprints: number; warnings: string[] } {
  const lib = doc.libraries[0];
  if (!lib) return { symbols: 0, footprints: 0, warnings: ['No library in it'] };
  const names = footprintNames(doc.libraries);
  const entries: LibEntry[] = [];
  const taken = new Set<string>();
  for (const ds of lib.devicesets.values()) for (const dev of ds.devices.values()) {
    const base = deviceName(ds.name, dev.name).replace(/[\\/:*?"<>|]/g, '_') || ds.name;
    let libRef = base;
    for (let k = 2; taken.has(libRef.toUpperCase()); k++) libRef = `${base}_${k}`;
    taken.add(libRef.toUpperCase());
    entries.push({ libRef, r: { lib, ds, dev, key: libRef }, footprint: dev.pkg ? names(lib, dev.pkg) : '' });
  }
  const s = eagleSymbolLibrary(entries, `${name}.PcbLib`);
  const pk = [...lib.packages.keys()].map((pkg) => ({ lib, pkg }));
  const f = pk.length ? eagleFootprintLibrary(doc, pk, names) : { footprints: [], warnings: [] };
  return {
    schLib: entries.length ? { name: `${name}.SchLib`, bytes: s.bytes } : undefined,
    pcbLib: f.footprints.length ? { name: `${name}.PcbLib`, bytes: ipcFootprintLibrary(f.footprints, `${name}.PcbLib`) } : undefined,
    symbols: s.count, footprints: f.footprints.length, warnings: [...s.warnings, ...f.warnings],
  };
}

export async function importEagle(files: ImportFile[], opts: ImportOptions = {}): Promise<ImportResult> {
  const out: ImportResult = { projects: [], libraries: [], messages: [] };
  const groups = new Map<string, { name: string; sch?: ImportFile; brd?: ImportFile }>();
  for (const f of files) {
    if (opts.only && !opts.only.has(f.path)) continue;
    const name = baseName(f.path);
    const head = td.decode(f.bytes.subarray(0, 4096));
    if (!takesEagle(name, head)) continue;
    if (!isEagleXml(head)) { out.messages.push({ level: 'error', source: stemOf(name), message: 'Not imported: EAGLE 5 or earlier kept its files binary; open and save it in EAGLE 6 or later (or Fusion Electronics) first' }); continue; }
    if (/\.lbr$/i.test(name)) {
      try {
        opts.progress?.(`${stemOf(name)}: library`);
        await yieldNow();
        const nm = safe(stemOf(name));
        const r = eagleLibraries(readEagle(f.bytes), nm);
        if (r.schLib) out.libraries.push(r.schLib);
        if (r.pcbLib) out.libraries.push(r.pcbLib);
        out.messages.push({ level: 'info', source: nm, message: `Library: ${r.symbols} device${r.symbols === 1 ? '' : 's'}, ${r.footprints} package${r.footprints === 1 ? '' : 's'}` });
        for (const w of r.warnings) out.messages.push({ level: 'warn', source: nm, message: w });
      } catch (e) { out.messages.push({ level: 'error', source: stemOf(name), message: `Not imported: ${(e as Error).message}` }); }
      continue;
    }
    // A schematic and a board of one name in one folder: one project
    const key = f.path.replace(/\\/g, '/').replace(/\.[^./]+$/, '').toLowerCase();
    const g = groups.get(key) ?? { name: stemOf(f.path) };
    if (/\.sch$/i.test(name)) g.sch = f; else g.brd = f;
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const name = safe(g.name);
    const documents: ImportedDoc[] = [];
    const prj = newPrjPcb(`${name}.PrjPcb`);
    try {
      opts.progress?.(`${name}: reading`);
      await yieldNow();
      const sch = g.sch ? readEagle(g.sch.bytes) : undefined;
      const brd = g.brd ? readEagle(g.brd.bytes) : undefined;
      if (sch && sch.kind !== 'sch') throw new Error(`${baseName(g.sch!.path)} holds no schematic`);
      if (brd && brd.kind !== 'brd') throw new Error(`${baseName(g.brd!.path)} holds no board`);
      // One naming of the packages for both (their libraries' union)
      const libs: ELib[] = [...(sch?.libraries ?? []), ...(brd?.libraries ?? [])];
      const seen = new Set<string>();
      const names = footprintNames(libs.filter((l) => { const k = `${l.name}\u0000${l.urn}`; if (seen.has(k)) return false; seen.add(k); return true; }));
      let schFootprints: Map<string, { lib: ELib; pkg: string }> | undefined;
      let netName: ((pins: string[]) => string | undefined) | undefined;
      let partValues: Map<string, string> | undefined;
      if (sch) {
        opts.progress?.(`${name}: schematic`);
        await yieldNow();
        const r = convertEagleSch(sch, name, `${name}.PcbLib`, names);
        // The file EAGLE wrote kept with the sheets, for the way back while they are unchanged (kept.ts)
        documents.push(...keepSch(r.sheets, g.sch!.bytes, baseName(g.sch!.path)), { name: `${name}.SchLib`, bytes: r.library });
        schFootprints = r.footprints;
        if (brd) {
          // The nets AD's compile names (a net no label names, by a pin of it): the board's automatic ones take them
          const c = compileProject(r.sheets.map((sh) => ({ name: sh.name, doc: readSchDoc(sh.bytes, sh.name) })), { scope: 3 });
          const byPin = new Map<string, string>();
          for (const n of c.nets) for (const pin of n.pins) byPin.set(`${pin.designator}.${pin.pin}`, n.name);
          partValues = new Map(c.components.map((x) => [x.designator.toUpperCase(), x.comment]));
          netName = (pins) => { const got = new Set(pins.map((q) => byPin.get(q)).filter((x): x is string => !!x)); return got.size === 1 ? [...got][0] : undefined; };
        }
        iniSet(prj, 'Design', 'HierarchyMode', '3');
        out.messages.push({ level: 'info', source: name, message: `Schematics: ${r.stats.sheets} sheet${r.stats.sheets === 1 ? '' : 's'}, ${r.stats.parts} parts, ${r.stats.nets} named nets; ${r.stats.symbols} symbols` });
        for (const w of r.warnings) out.messages.push({ level: 'warn', source: name, message: w });
      }
      if (brd) {
        opts.progress?.(`${name}: board`);
        await yieldNow();
        const r = convertEagleBrd(brd, name, { stem: name, names, netName, parts: partValues });
        documents.push({ name: `${name}.PcbDoc`, bytes: keepBrd(r.bytes, `${name}.PcbDoc`, g.brd!.bytes, baseName(g.brd!.path), r.signals, r.layers) });
        if (r.footprints.length) documents.push({ name: `${name}.PcbLib`, bytes: ipcFootprintLibrary(r.footprints, `${name}.PcbLib`) });
        out.messages.push({ level: 'info', source: name, message: `Board: ${r.stats.layers} copper layers, ${r.stats.components} components, ${r.stats.pads} pads, ${r.stats.vias} vias, ${r.stats.tracks} tracks and arcs, ${r.stats.pours} polygons, ${r.stats.nets} nets; ${r.footprints.length} footprints` });
        for (const w of r.warnings) out.messages.push({ level: 'warn', source: name, message: w });
      } else if (sch && schFootprints?.size) {
        // No board: the packages its parts use, as its PcbLib
        const f = eagleFootprintLibrary(sch, [...schFootprints.values()], names);
        if (f.footprints.length) documents.push({ name: `${name}.PcbLib`, bytes: ipcFootprintLibrary(f.footprints, `${name}.PcbLib`) });
      }
      if (sch && brd) for (const w of eagleConsistency(sch, brd)) out.messages.push({ level: 'warn', source: name, message: w });
      for (const d of documents) addDocument(prj, d.name);
      if (documents.length) out.projects.push({ name, prj: { name: `${name}.PrjPcb`, bytes: writePrjPcb(prj) }, documents });
    } catch (e) { out.messages.push({ level: 'error', source: name, message: `Not imported: ${(e as Error).message}` }); }
  }
  return out;
}
