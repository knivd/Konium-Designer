/**
 * File › Import Wizard for KiCad (6 and later): projects (.kicad_pro with their schematics and
 * board) become AD projects — SchDocs (one per sheet instance), the PcbDoc, a SchLib per symbol
 * library and a PcbLib per footprint library the design uses (from the symbols and footprints
 * the files carry), the PrjPcb listing them with KiCad's text variables as project parameters;
 * the board takes KiCad's design rules and net classes. A schematic or board without a project
 * file is imported as one of its own; symbol libraries (.kicad_sym) and footprint libraries
 * (.pretty folders, .kicad_mod files) outside a project become SchLibs and PcbLibs.
 */
import { addDocument, iniSet, newPrjPcb, setProjectParameters, writePrjPcb } from '../altium/prjpcb';
import { convertBoard, parseBoard, convertFootprintLibrary, footprintLibrary, netNamesFrom, type KicadRules } from './board';
import { compileProject } from '../../model/compile';
import { readSchDoc } from '../altium/schdoc';
import { convertSchematics, convertSymbolLibrary, convertSymbols, normPath, schematicLibraries } from './schematic';
import { parseSexpr } from './sexpr';

import type { ImportFile, ImportedDoc, ImportedProject, ImportMessage, ImportOptions, ImportResult } from '../importers';
import { breathe } from '../../core/breathe';
export type { ImportFile, ImportedDoc, ImportedProject, ImportMessage, ImportResult };

const td = new TextDecoder();
const bytesToText = (b: Uint8Array): string => td.decode(b);

export const KICAD_FILE = /\.(kicad_pro|kicad_sch|kicad_pcb|kicad_sym|kicad_mod|kicad_dru|kicad_prl)$/i;
/** A text kept in the PrjPcb on one line (a JSON string, its characters past ASCII escaped): KiCad's project files for the way back. */
export const keepLine = (t: string): string => JSON.stringify(t).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
/** KiCad's project files kept in a PrjPcb ([KiCad]: Project, Rules, Local), as they were. */
export function keptProjectFiles(get: (key: string) => string | undefined): { pro?: string; dru?: string; prl?: string } {
  const one = (k: string) => { const v = get(k); if (!v) return undefined; try { const t = JSON.parse(v) as unknown; return typeof t === 'string' ? t : undefined; } catch { return undefined; } };
  return { pro: one('Project'), dru: one('Rules'), prl: one('Local') };
}
/** What a set of files holds for the wizard's list (a loose schematic another one includes as a sheet isn't listed). */
export function kicadContents(files: { path: string; bytes?: Uint8Array }[]): { projects: string[]; schematics: string[]; boards: string[]; symbolLibs: string[]; footprintLibs: string[] } {
  const ps = files.map((f) => normPath(f.path));
  const dirOf = (p: string) => p.split('/').slice(0, -1).join('/');
  const projDirs = new Set(ps.filter((p) => /\.kicad_pro$/i.test(p)).map(dirOf));
  const inProject = (p: string) => [...projDirs].some((d) => d === '' || p.startsWith(`${d}/`));
  const loose = (re: RegExp) => ps.filter((p) => re.test(p) && !projDirs.has(dirOf(p)));
  // Sheets the loose schematics include (KiCad 6: "Sheet file", later "Sheetfile")
  const sub = new Set<string>();
  files.forEach((f, i) => {
    if (!f.bytes || !/\.kicad_sch$/i.test(ps[i]!)) return;
    for (const m of bytesToText(f.bytes).matchAll(/\(property\s+"Sheet ?file"\s+"([^"]+)"/g)) sub.add(normPath(`${dirOf(ps[i]!) ? `${dirOf(ps[i]!)}/` : ''}${m[1]}`).toLowerCase());
  });
  return {
    projects: ps.filter((p) => /\.kicad_pro$/i.test(p)),
    schematics: loose(/\.kicad_sch$/i).filter((p) => !sub.has(p.toLowerCase())),
    boards: loose(/\.kicad_pcb$/i),
    symbolLibs: ps.filter((p) => /\.kicad_sym$/i.test(p) && !inProject(p)),
    footprintLibs: [...new Set(ps.filter((p) => /\.kicad_mod$/i.test(p) && !inProject(p)).map(dirOf))],
  };
}

/** KiCad's project settings (.kicad_pro, JSON): the board's rules and net classes, and the text variables. */
export function projectSettings(json: string): { rules: KicadRules; variables: { name: string; value: string }[] } {
  let j: Record<string, any>;
  try { j = JSON.parse(json) as Record<string, any>; } catch { return { rules: {}, variables: [] }; }
  const r = j.board?.design_settings?.rules ?? {};
  const ns = j.net_settings ?? {};
  const classes: NonNullable<KicadRules['classes']> = (ns.classes ?? []).map((c: Record<string, any>) => ({
    name: String(c.name ?? ''), clearance: num(c.clearance), trackWidth: num(c.track_width), viaDiameter: num(c.via_diameter), viaDrill: num(c.via_drill),
    nets: Array.isArray(c.nets) ? c.nets.map(String) : [], patterns: [] as string[],
  }));
  const byName = new Map(classes.map((c) => [c.name, c]));
  for (const p of ns.netclass_patterns ?? []) byName.get(String(p.netclass))?.patterns!.push(String(p.pattern));
  for (const [net, cls] of Object.entries(ns.netclass_assignments ?? {})) for (const c of Array.isArray(cls) ? cls : [cls]) byName.get(String(c))?.nets.push(net);
  const def = byName.get('Default');
  return {
    rules: {
      clearance: def?.clearance, trackWidth: def?.trackWidth, viaDiameter: def?.viaDiameter, viaDrill: def?.viaDrill,
      minTrack: num(r.min_track_width), minClearance: num(r.min_clearance), minVia: num(r.min_via_diameter), minDrill: num(r.min_through_hole_diameter),
      holeToHole: num(r.min_hole_to_hole), copperEdge: num(r.min_copper_edge_clearance), classes,
    },
    variables: Object.entries(j.text_variables ?? {}).map(([name, value]) => ({ name, value: String(value) })),
  };
}
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Convert what was picked: each project (or loose schematic or board) and loose library. */
const yieldNow = breathe;

export async function importKicad(files: ImportFile[], opts: ImportOptions = {}): Promise<ImportResult> {
  const { only, progress } = opts;
  const step = async (s: string) => { progress?.(s); await yieldNow(); };
  const byPath = new Map(files.map((f) => [normPath(f.path), f]));
  const text = (p: string) => { const f = byPath.get(p); return f ? bytesToText(f.bytes) : undefined; };
  const messages: ImportMessage[] = [];
  const projects: ImportedProject[] = [];
  const libraries: ImportedDoc[] = [];
  const c = kicadContents(files);
  const dirOf = (p: string) => p.split('/').slice(0, -1).join('/');
  const stemOf = (p: string) => (p.split('/').pop() ?? p).replace(/\.[^.]+$/, '');
  const want = (p: string) => !only || only.has(p);

  const one = async (name: string, dir: string, schPath: string | null, pcbPath: string | null, proPath: string | null) => {
    const docs: ImportedDoc[] = [];
    const settings = proPath ? projectSettings(text(proPath) ?? '{}') : { rules: {}, variables: [] };
    const trees = [];
    const sheetDocs: ImportedDoc[] = [];
    if (schPath) {
      await step(`${name}: schematics`);
      // Every schematic under the project's folder, by its path from there
      const sch = new Map<string, string>();
      for (const [p, f] of byPath) if (/\.kicad_sch$/i.test(p) && (dir === '' || p.startsWith(`${dir}/`))) sch.set(dir ? p.slice(dir.length + 1) : p, bytesToText(f.bytes));
      try {
        const sheets = convertSchematics(sch, dir ? schPath.slice(dir.length + 1) : schPath, name);
        for (const s of sheets) { docs.push({ name: s.name, bytes: s.bytes }); sheetDocs.push({ name: s.name, bytes: s.bytes }); }
        for (const t of sch.values()) { try { trees.push(parseSexpr(t)); } catch { /* reported by the sheet */ } }
        messages.push({ level: 'info', source: name, message: `${sheets.length} schematic sheet${sheets.length === 1 ? '' : 's'}` });
      } catch (e) { messages.push({ level: 'error', source: stemOf(schPath), message: `Schematic not imported: ${(e as Error).message}` }); }
      for (const [lib, syms] of schematicLibraries(trees)) {
        try { docs.push({ name: `${lib}.SchLib`, bytes: convertSymbols(syms).bytes }); } catch (e) { messages.push({ level: 'warn', source: lib, message: `Symbol library not made: ${(e as Error).message}` }); }
      }
      // (the sheets read again for their libraries let go before the board is read)
      trees.length = 0;
    }
    if (pcbPath) {
      await step(`${name}: board`);
      try {
        const tree = parseBoard(text(pcbPath) ?? '');
        // The board's nets as the schematics compile (Hierarchical, as KiCad connects sheets)
        let netNames: Map<string, string> | undefined;
        if (sheetDocs.length) {
          try { netNames = netNamesFrom(tree, compileProject(sheetDocs.map((d) => ({ name: d.name, doc: readSchDoc(d.bytes, d.name) })), { scope: 2 }).nets); }
          catch (e) { messages.push({ level: 'warn', source: name, message: `Net names kept as KiCad's: ${(e as Error).message}` }); }
        }
        const b = convertBoard('', { name: `${stemOf(pcbPath)}.PcbDoc`, rules: settings.rules, tree, netNames });
        docs.push({ name: `${stemOf(pcbPath)}.PcbDoc`, bytes: b.bytes });
        for (const [lib, fps] of b.footprints) docs.push({ name: `${lib}.PcbLib`, bytes: footprintLibrary(fps, `${lib}.PcbLib`) });
        messages.push({ level: 'info', source: name, message: `Board: ${b.stats.components} components, ${b.stats.tracks} tracks, ${b.stats.vias} vias, ${b.stats.pours} polygon pours` });
        for (const w of b.warnings) messages.push({ level: 'warn', source: stemOf(pcbPath), message: w });
      } catch (e) { messages.push({ level: 'error', source: stemOf(pcbPath), message: `Board not imported: ${(e as Error).message}` }); }
    }
    if (!docs.length) return;
    // Names unique within the project (a library named as a sheet keeps both)
    const seen = new Set<string>();
    const unique = docs.filter((d) => { const k = d.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    const prj = newPrjPcb(`${name}.PrjPcb`);
    iniSet(prj, 'Design', 'HierarchyMode', '2');
    for (const d of unique) addDocument(prj, d.name);
    if (settings.variables.length) setProjectParameters(prj, settings.variables);
    // KiCad's project settings, custom rules and local settings as they were, for the way back (export.ts: merged with Konium's)
    const beside = (ext: string) => (proPath ? text(proPath.replace(/\.kicad_pro$/i, ext)) : undefined);
    for (const [k, t] of [['Project', proPath ? text(proPath) : undefined], ['Rules', beside('.kicad_dru')], ['Local', beside('.kicad_prl')]] as const) if (t) iniSet(prj, 'KiCad', k, keepLine(t));
    projects.push({ name, prj: { name: `${name}.PrjPcb`, bytes: writePrjPcb(prj) }, documents: unique });
  };

  for (const pro of c.projects) {
    if (!want(pro)) continue;
    const dir = dirOf(pro), stem = stemOf(pro);
    const sch = `${dir ? `${dir}/` : ''}${stem}.kicad_sch`, pcb = `${dir ? `${dir}/` : ''}${stem}.kicad_pcb`;
    if (!byPath.has(sch) && !byPath.has(pcb)) { messages.push({ level: 'warn', source: stem, message: `${stem}.kicad_sch and ${stem}.kicad_pcb weren't among the files` }); continue; }
    await one(stem, dir, byPath.has(sch) ? sch : null, byPath.has(pcb) ? pcb : null, pro);
  }
  for (const s of c.schematics) if (want(s)) {
    const pcb = s.replace(/\.kicad_sch$/i, '.kicad_pcb');
    await one(stemOf(s), dirOf(s), s, byPath.has(pcb) && c.boards.includes(pcb) ? pcb : null, null);
  }
  for (const b of c.boards) if (want(b) && !c.schematics.includes(b.replace(/\.kicad_pcb$/i, '.kicad_sch'))) await one(stemOf(b), dirOf(b), null, b, null);
  for (const l of c.symbolLibs) if (want(l)) {
    await step(`${stemOf(l)}: symbols`);
    try { const r = convertSymbolLibrary(text(l) ?? ''); libraries.push({ name: `${stemOf(l)}.SchLib`, bytes: r.bytes }); messages.push({ level: 'info', source: stemOf(l), message: `${r.count} symbols` }); }
    catch (e) { messages.push({ level: 'error', source: stemOf(l), message: `Not imported: ${(e as Error).message}` }); }
  }
  for (const d of c.footprintLibs) if (want(d)) {
    const mods = [...byPath].filter(([p]) => /\.kicad_mod$/i.test(p) && dirOf(p) === d).map(([p, f]) => ({ name: p.split('/').pop()!, text: bytesToText(f.bytes) }));
    const lib = (d.split('/').pop() || 'Footprints').replace(/\.pretty$/i, '');
    await step(`${lib}: footprints`);
    try { const r = convertFootprintLibrary(mods, lib); libraries.push({ name: `${lib}.PcbLib`, bytes: r.bytes }); messages.push({ level: 'info', source: lib, message: `${r.count} footprints` }); }
    catch (e) { messages.push({ level: 'error', source: lib, message: `Not imported: ${(e as Error).message}` }); }
  }
  return { projects, libraries, messages };
}
