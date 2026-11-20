/**
 * Cadence's files through the Import Wizard: OrCAD Capture designs (.dsn) as schematics with their
 * parts as a schematic library, Capture libraries (.olb) as schematic libraries, and Allegro and
 * OrCAD PCB Editor boards (.brd) as PCBs with their symbols as a PCB library. A design and a board
 * of one name (or the only design and the only board imported together) are one project, the
 * board's components tied to the schematic's parts.
 */
import { addDocument, iniSet, newPrjPcb, writePrjPcb } from './altium/prjpcb';
import { readOrcad, isOrcadFile } from './orcad/dsnRead';
import { convertOrcadLib, convertOrcadSch } from './orcad/dsnSch';
import { convertAllegroBrd } from './allegro/brdBoard';
import { isAllegroBrd } from './allegro/brdRead';
import { writePcbLib } from './altium/pcblib';
import { keepBrd, keepDsn } from './cadenceKept';
import { readSchDoc } from './altium/schdoc';
import { compileProject } from '../model/compile';
import type { ImportedDoc, ImportFile, ImportItem, ImportOptions, ImportResult } from './importers';
import { breathe } from '../core/breathe';

const stemOf = (p: string) => (p.split('/').pop() ?? p).replace(/\.[^.]+$/, '');
const yieldNow = breathe;

/** An Allegro board by its name and first bytes (Allegro 16 on: a little-endian magic 0x0013xxxx–0x0016xxxx). */
export const takesBrd = (name: string, head: string): boolean => /\.brd$/i.test(name) && head.length >= 4 && head.charCodeAt(3) === 0 && head.charCodeAt(2) >= 0x0f && head.charCodeAt(2) <= 0x16;
/** A Capture design or library (a compound file, not a Specctra .dsn, which is text). */
export const takesOrcad = (name: string, head: string): boolean => /\.(dsn|olb)$/i.test(name) && !/^\s*\(/.test(head);

type Kind = 'dsn' | 'olb' | 'brd';
const kindOf = (path: string): Kind | null => (/\.dsn$/i.test(path) ? 'dsn' : /\.olb$/i.test(path) ? 'olb' : /\.brd$/i.test(path) ? 'brd' : null);

/** Designs and boards paired: in one folder by name, else by name across folders, else the only design with the only board. */
function pairs<T extends { path: string }>(files: T[]): { name: string; dsn?: T; brd?: T }[] {
  const out = new Map<string, { name: string; dsn?: T; brd?: T }>();
  for (const f of files) {
    const k = kindOf(f.path);
    if (k !== 'dsn' && k !== 'brd') continue;
    const key = f.path.replace(/\\/g, '/').replace(/\.[^./]+$/, '').toLowerCase();
    const g = out.get(key) ?? { name: stemOf(f.path) };
    if (g[k]) { out.set(`${key}\u0000${out.size}`, { name: stemOf(f.path), [k]: f }); continue; }
    g[k] = f;
    out.set(key, g);
  }
  const groups = [...out.values()];
  const lone = (k: 'dsn' | 'brd') => groups.filter((g) => g[k] && !g[k === 'dsn' ? 'brd' : 'dsn']);
  const join = (d: { brd?: T }, b: { brd?: T }) => { d.brd = b.brd; groups.splice(groups.indexOf(b as { name: string; brd?: T }), 1); };
  for (const d of lone('dsn')) {
    const same = lone('brd').filter((b) => b.name.toLowerCase() === d.name.toLowerCase());
    if (same.length === 1) join(d, same[0]!);
  }
  const [ds, bs] = [lone('dsn'), lone('brd')];
  if (ds.length === 1 && bs.length === 1) join(ds[0]!, bs[0]!);
  return groups;
}

export function listCadence(all: { path: string; bytes?: Uint8Array }[]): ImportItem[] {
  // A .brd that isn't Allegro's (EAGLE's, by its bytes): not this importer's
  const files = all.filter((f) => !(f.bytes && /\.brd$/i.test(f.path) && !takesBrd(f.path, new TextDecoder().decode(f.bytes.subarray(0, 16)))));
  const items: ImportItem[] = [];
  // A design and its board one after the other (one project)
  for (const g of pairs(files)) {
    if (g.dsn) items.push({ path: g.dsn.path, kind: 'Schematic' });
    if (g.brd) items.push({ path: g.brd.path, kind: 'PCB' });
  }
  for (const f of files) if (kindOf(f.path) === 'olb') items.push({ path: f.path, kind: 'Schematic library' });
  return items;
}

export async function importCadence(files: ImportFile[], opts: ImportOptions = {}): Promise<ImportResult> {
  const out: ImportResult = { projects: [], libraries: [], messages: [] };
  // What was chosen, paired
  const usable = files.filter((f) => kindOf(f.path) && (!opts.only || opts.only.has(f.path)));
  const groups = pairs(usable);
  for (const g of groups) {
    const name = g.dsn ? stemOf(g.dsn.path) : g.name;
    const documents: ImportedDoc[] = [];
    const prj = newPrjPcb(`${name}.PrjPcb`);
    try {
      let boardName = '';
      let pinNets: Map<string, string> | undefined;
      let comments: Map<string, string> | undefined;
      let footprintLib = '';
      if (g.brd) { boardName = stemOf(g.brd.path).replace(/[\\/:*?"<>|]/g, '_'); footprintLib = `${boardName}.PcbLib`; }
      if (g.dsn) {
        opts.progress?.(`${name}: schematics`);
        await yieldNow();
        if (!isOrcadFile(g.dsn.bytes)) throw new Error(`${g.dsn.path.split('/').pop()} isn't an OrCAD Capture design`);
        const d = readOrcad(g.dsn.bytes);
        const r = convertOrcadSch(d, name, footprintLib, opts.orcadFootprintField);
        // (the design's file kept with its sheets, for the way back: cadenceKept.ts)
        documents.push(...keepDsn(r.sheets, g.dsn.bytes, g.dsn.path), { name: `${name}.SchLib`, bytes: r.library });
        iniSet(prj, 'Design', 'HierarchyMode', String(r.scope));
        // The board's nets take the names the schematics compile to (Update PCB then has little to change)
        if (g.brd) {
          try {
            const c = compileProject(r.sheets.map((sh) => ({ name: sh.name, doc: readSchDoc(sh.bytes, sh.name) })), { scope: r.scope });
            pinNets = new Map(c.nets.flatMap((n) => n.pins.map((p): [string, string] => [`${p.designator}\u0000${p.pin}`, n.name])));
            comments = new Map(c.components.filter((x) => x.designator).map((x) => [x.designator, x.comment]));
          } catch { /* the board keeps Allegro's names */ }
        }
        out.messages.push({ level: 'info', source: name, message: `Schematics: ${r.stats.sheets} sheet${r.stats.sheets === 1 ? '' : 's'}, ${r.stats.parts} parts, ${r.stats.nets} named nets; ${r.stats.symbols} symbols` });
        for (const w of r.warnings) out.messages.push({ level: 'warn', source: name, message: w });
      }
      if (g.brd) {
        opts.progress?.(`${boardName}: board`);
        await yieldNow();
        if (!isAllegroBrd(g.brd.bytes)) throw new Error(`${g.brd.path.split('/').pop()} isn't an Allegro board (Allegro 16.0 or later)`);
        const r = convertAllegroBrd(g.brd.bytes, g.brd.path.split('/').pop() ?? g.brd.path, { pinNets, comments });
        documents.push({ name: `${r.name}.PcbDoc`, bytes: keepBrd(r.bytes, `${r.name}.PcbDoc`, g.brd.bytes, g.brd.path) });
        if (r.footprints.length) documents.push({ name: `${r.name}.PcbLib`, bytes: writePcbLib([...r.footprints].sort((a, b) => a.name.localeCompare(b.name)), `${r.name}.PcbLib`) });
        out.messages.push({ level: 'info', source: r.name, message: `Board: ${r.stats.layers} copper layers, ${r.stats.components} components, ${r.stats.pads} pads, ${r.stats.vias} vias, ${r.stats.tracks} tracks and arcs, ${r.stats.pours} polygon pours, ${r.stats.nets} nets; ${r.footprints.length} footprints` });
        for (const w of r.warnings) out.messages.push({ level: 'warn', source: r.name, message: w });
      }
      for (const doc of documents) addDocument(prj, doc.name);
      out.projects.push({ name, prj: { name: `${name}.PrjPcb`, bytes: writePrjPcb(prj) }, documents });
    } catch (e) { out.messages.push({ level: 'error', source: name, message: `Not imported: ${(e as Error).message}` }); }
  }
  for (const f of usable) {
    if (kindOf(f.path) !== 'olb' || (opts.only && !opts.only.has(f.path))) continue;
    const name = stemOf(f.path);
    opts.progress?.(`${name}: library`);
    await yieldNow();
    try {
      if (!isOrcadFile(f.bytes)) throw new Error(`${f.path.split('/').pop()} isn't an OrCAD Capture library`);
      const r = convertOrcadLib(readOrcad(f.bytes));
      out.libraries.push({ name: `${name}.SchLib`, bytes: r.library });
      out.messages.push({ level: 'info', source: name, message: `Schematic library: ${r.symbols} components` });
      for (const w of r.warnings) out.messages.push({ level: 'warn', source: name, message: w });
    } catch (e) { out.messages.push({ level: 'error', source: name, message: `Not imported: ${(e as Error).message}` }); }
  }
  return out;
}
