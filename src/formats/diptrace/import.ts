/**
 * DipTrace's XML files into AD projects (DipTrace's File › Export › DipTrace XML in Schematic
 * Capture and PCB Layout, Library › Export › DipXML in its library editors): a schematic (.dchxml) and a board
 * (.dipxml) of one name in one folder are one project (its sheets, the SchLib of its components,
 * the board and the PcbLib of its patterns), a lone schematic or board a project of its own; a
 * component library (.elixml) a SchLib of its components and a PcbLib of their patterns, a
 * pattern library a PcbLib. DipTrace's nets are design-wide: the projects' Net Identifier Scope is
 * Global. Each board and schematic keeps the file it came from: exported back to DipTrace
 * unchanged, it is that file byte for byte (kept.ts). DipTrace's own binary files (.dch, .dip, .eli,
 * .lib) are named, not read: DipTrace exports them as XML.
 */
import { addDocument, iniSet, newPrjPcb, writePrjPcb } from '../altium/prjpcb';
import { ipcFootprintLibrary } from '../ipc2581read';
import type { ImportedDoc, ImportFile, ImportItem, ImportOptions, ImportResult } from '../importers';
import { readSchDoc } from '../altium/schdoc';
import { compileProject } from '../../model/compile';
import { isDipTraceXml, readDipTrace, type DtDoc } from './read';
import { convertDipTracePcb, dipTraceFootprintLibrary } from './pcb';
import { convertDipTraceSch, dipTraceSymbolLibrary, symbolNames } from './sch';
import { keepDch, keepDip } from './kept';
import { patternNameMap } from './read';
import { breathe } from '../../core/breathe';

const td = new TextDecoder();
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const stemOf = (p: string) => baseName(p).replace(/\.[^.]+$/, '');
const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_').trim() || 'DipTrace';
const yieldNow = breathe;
const EXT = /\.(dipxml|dchxml|elixml|libxml|xml)$/i;
const BINARY = /\.(dch|dip|eli)$/i;

/** Whether the importer takes a file: DipTrace's XML (by its first bytes); its binary files by name, to say how to export them. */
export function takesDipTrace(name: string, head: string): boolean {
  if (BINARY.test(name)) return true;
  return EXT.test(name) && isDipTraceXml(head);
}

const kindOf = (head: string): string => {
  if (/Type="DipTrace-PCB"/.test(head)) return 'PCB';
  if (/Type="DipTrace-Schematic"/.test(head)) return 'Schematic';
  if (/Type="DipTrace-ComponentLibrary"/.test(head)) return 'Component Library';
  if (/Type="DipTrace-PatternLibrary"/.test(head)) return 'Pattern Library';
  return 'DipTrace binary file';
};
export function listDipTrace(files: { path: string; bytes?: Uint8Array }[]): ImportItem[] {
  return files.filter((f) => (EXT.test(f.path) || BINARY.test(f.path)) && (!f.bytes || takesDipTrace(f.path, td.decode(f.bytes.subarray(0, 4096))))).map((f) => {
    const head = f.bytes ? td.decode(f.bytes.subarray(0, 4096)) : '';
    const kind = f.bytes ? kindOf(head) : BINARY.test(f.path) ? 'DipTrace binary file' : 'DipTrace XML';
    return { path: f.path, kind, ...(kind === 'DipTrace binary file' ? { note: 'export it from DipTrace as DipTrace XML first' } : {}) };
  });
}

/** A component library's components and patterns, or a pattern library's patterns: its SchLib and PcbLib. */
export function dipTraceLibraries(doc: DtDoc, name: string): { schLib?: ImportedDoc; pcbLib?: ImportedDoc; symbols: number; footprints: number; warnings: string[] } {
  const styles = [...doc.components.keys()];
  const refs = symbolNames(doc, styles);
  const fp = dipTraceFootprintLibrary(doc);
  const fpOf = patternNameMap(doc);
  const s = styles.length ? dipTraceSymbolLibrary(doc, styles.map((st) => {
    const ps = doc.components.get(st)?.children.find((c) => c.name === 'Part')?.children.find((c) => c.name === 'Pattern');
    const pst = ps?.attrs.Style ?? ps?.attrs.PatternType ?? '';
    return { style: st, libRef: refs.get(st)!, footprint: pst && fpOf.has(pst) ? fpOf.get(pst)! : '' };
  }), `${name}.PcbLib`) : { bytes: new Uint8Array(), count: 0, warnings: [] };
  return {
    schLib: s.count ? { name: `${name}.SchLib`, bytes: s.bytes } : undefined,
    pcbLib: fp.footprints.length ? { name: `${name}.PcbLib`, bytes: ipcFootprintLibrary(fp.footprints, `${name}.PcbLib`) } : undefined,
    symbols: s.count, footprints: fp.footprints.length, warnings: [...s.warnings, ...fp.warnings],
  };
}

/** Footprint names for a design's pattern styles: each pattern's name, made unique (as the board names them). */
function patternNames(doc: DtDoc): (style: string) => string {
  const m = patternNameMap(doc);
  return (style) => m.get(style) ?? style;
}

export async function importDipTrace(files: ImportFile[], opts: ImportOptions = {}): Promise<ImportResult> {
  const out: ImportResult = { projects: [], libraries: [], messages: [] };
  const groups = new Map<string, { name: string; sch?: ImportFile; pcb?: ImportFile }>();
  for (const f of files) {
    if (opts.only && !opts.only.has(f.path)) continue;
    const name = baseName(f.path);
    const head = td.decode(f.bytes.subarray(0, 4096));
    if (!takesDipTrace(name, head)) continue;
    if (BINARY.test(name) && !isDipTraceXml(head)) { out.messages.push({ level: 'error', source: stemOf(name), message: 'Not imported: DipTrace\'s own binary file; export it from DipTrace as DipTrace XML (File › Export › DipTrace XML; a library: Library › Export › DipXML) first' }); continue; }
    const kind = kindOf(head);
    if (kind === 'Component Library' || kind === 'Pattern Library') {
      try {
        opts.progress?.(`${stemOf(name)}: library`);
        await yieldNow();
        const nm = safe(stemOf(name));
        const r = dipTraceLibraries(readDipTrace(f.bytes), nm);
        if (r.schLib) out.libraries.push(r.schLib);
        if (r.pcbLib) out.libraries.push(r.pcbLib);
        out.messages.push({ level: 'info', source: nm, message: `Library: ${r.symbols} component${r.symbols === 1 ? '' : 's'}, ${r.footprints} pattern${r.footprints === 1 ? '' : 's'}` });
        for (const w of r.warnings) out.messages.push({ level: 'warn', source: nm, message: w });
      } catch (e) { out.messages.push({ level: 'error', source: stemOf(name), message: `Not imported: ${(e as Error).message}` }); }
      continue;
    }
    // A schematic and a board of one name in one folder: one project
    const key = f.path.replace(/\\/g, '/').replace(/\.[^./]+$/, '').replace(/[-_ ](pcb|sch|schematic|board|layout)$/i, '').toLowerCase();
    const g = groups.get(key) ?? { name: stemOf(f.path).replace(/[-_ ](pcb|sch|schematic|board|layout)$/i, '') || stemOf(f.path) };
    if (kind === 'Schematic') { if (g.sch) groups.set(`${key}\u0000${f.path}`, { name: stemOf(f.path), sch: f }); else g.sch = f; }
    else if (g.pcb) groups.set(`${key}\u0000${f.path}`, { name: stemOf(f.path), pcb: f }); else g.pcb = f;
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const name = safe(g.name);
    const documents: ImportedDoc[] = [];
    const prj = newPrjPcb(`${name}.PrjPcb`);
    try {
      opts.progress?.(`${name}: reading`);
      await yieldNow();
      const sch = g.sch ? readDipTrace(g.sch.bytes) : undefined;
      const pcb = g.pcb ? readDipTrace(g.pcb.bytes) : undefined;
      let netName: ((pins: string[]) => string | undefined) | undefined;
      let schPatterns: { doc: DtDoc; styles: Set<string> } | undefined;
      if (sch) {
        opts.progress?.(`${name}: schematic`);
        await yieldNow();
        // Footprints by their patterns' names (each file numbers its pattern styles its own way; DipTrace pairs them by name)
        const r = convertDipTraceSch(sch, name, `${name}.PcbLib`, patternNames(sch));
        const kept = keepDch(r.sheets, g.sch!.bytes, baseName(g.sch!.path));
        documents.push(...kept, { name: `${name}.SchLib`, bytes: r.library });
        schPatterns = { doc: sch, styles: r.patterns };
        if (pcb) {
          // The nets AD's compile names (a net no label names, by a pin of it): the board's automatic ones take them
          const c = compileProject(kept.map((sh) => ({ name: sh.name, doc: readSchDoc(sh.bytes, sh.name) })), { scope: 3 });
          const byPin = new Map<string, string>();
          for (const n of c.nets) for (const pin of n.pins) byPin.set(`${pin.designator}.${pin.pin}`, n.name);
          netName = (pins) => { const got = new Set(pins.map((q) => byPin.get(q)).filter((x): x is string => !!x)); return got.size === 1 ? [...got][0] : undefined; };
        }
        iniSet(prj, 'Design', 'HierarchyMode', '3');
        out.messages.push({ level: 'info', source: name, message: `Schematics: ${r.stats.sheets} sheet${r.stats.sheets === 1 ? '' : 's'}, ${r.stats.parts} parts, ${r.stats.nets} named nets; ${r.stats.symbols} symbols` });
        for (const w of r.warnings) out.messages.push({ level: 'warn', source: name, message: w });
      }
      if (pcb) {
        opts.progress?.(`${name}: board`);
        await yieldNow();
        const r = convertDipTracePcb(pcb, name, { stem: name, netName });
        documents.push({ name: `${name}.PcbDoc`, bytes: keepDip(r.bytes, `${name}.PcbDoc`, g.pcb!.bytes, baseName(g.pcb!.path)) });
        if (r.footprints.length) documents.push({ name: `${name}.PcbLib`, bytes: ipcFootprintLibrary(r.footprints, `${name}.PcbLib`) });
        out.messages.push({ level: 'info', source: name, message: `Board: ${r.stats.layers} copper layers, ${r.stats.components} components, ${r.stats.pads} pads, ${r.stats.vias} vias, ${r.stats.tracks} tracks and arcs, ${r.stats.pours} pours, ${r.stats.nets} nets; ${r.footprints.length} footprints` });
        for (const w of r.warnings) out.messages.push({ level: 'warn', source: name, message: w });
      } else if (schPatterns?.styles.size) {
        // No board: the patterns its parts use, as its PcbLib
        const f = dipTraceFootprintLibrary(schPatterns.doc, [...schPatterns.styles]);
        if (f.footprints.length) documents.push({ name: `${name}.PcbLib`, bytes: ipcFootprintLibrary(f.footprints, `${name}.PcbLib`) });
      }
      for (const d of documents) addDocument(prj, d.name);
      if (documents.length) out.projects.push({ name, prj: { name: `${name}.PrjPcb`, bytes: writePrjPcb(prj) }, documents });
    } catch (e) { out.messages.push({ level: 'error', source: name, message: `Not imported: ${(e as Error).message}` }); }
  }
  return out;
}
