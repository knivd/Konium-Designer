/**
 * EasyEDA's files into AD projects: Standard's JSON documents (a schematic and a board of one
 * name, or of one backup, a project; a footprint a PcbLib) and its backups (.zip, zips within
 * zips); Pro's projects (.epro, .epro2, a project's .zip: each board — its schematic and its PCB —
 * a project, a schematic or PCB of no board one of its own) and libraries (.elibz, .elibz2, .efoo,
 * .esym: a SchLib and a PcbLib). EasyEDA joins nets by name across its pages: the projects' Net
 * Identifier Scope is Global.
 */
import { addDocument, iniSet, newPrjPcb, writePrjPcb } from '../altium/prjpcb';
import { ipcFootprintLibrary } from '../ipc2581read';
import { unzipEntries } from '../xlsxRead';
import type { ImportedDoc, ImportFile, ImportItem, ImportOptions, ImportResult } from '../importers';
import { convertEasyedaPcb, easyedaDocType } from './stdPcb';
import { convertEasyedaSch } from './stdSch';
import { isEasyedaPro, readEasyedaPro, type ProProject } from './proRead';
import { convertProPcb, proFootprintLibrary } from './proPcb';
import { convertProSch, proSymbolLibrary } from './proSch';
import { breathe } from '../../core/breathe';

const td = new TextDecoder();
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_').trim() || 'EasyEDA';
const yieldNow = breathe;
/** What an EasyEDA file name keeps of its document's name (its export prefixes and date gone). */
const stemOf = (p: string) => baseName(p).replace(/\.[^.]+$/, '').replace(/^\d+-/, '').replace(/^(SCH_|PCB_|Schematic_|ProProject_)+/i, '').replace(/_\d{4}-\d{2}-\d{2}$/, '').trim();

/** Standard's document type from its first bytes (3 board, 4 footprint, 5 schematic, 1 sheet, 2 symbol), else 0. */
export function easyedaStdType(head: string): number {
  if (!/^\s*\{/.test(head)) return 0;
  const m = /"docType"\s*:\s*"?(\d+)/.exec(head);
  return m && (/"head"\s*:|"canvas"\s*:|"schematics"\s*:|"shape"\s*:/.test(head) || /"editorVersion"/.test(head)) ? Number(m[1]) : 0;
}
const isZip = (b: Uint8Array) => b[0] === 0x50 && b[1] === 0x4b;
const ZIP_MARK = /(^|[\0/])(SHEET|PCB|SYMBOL|FOOTPRINT|BLOB|POUR|FONT|INSTANCE|IMAGE)\/|project2?\.json|\.epru|\.elibu|\.json/;

/** Whether the importer takes a file (by name, then by its first bytes). */
export function takesEasyeda(name: string, head: string): boolean {
  if (/\.(epro2?|elibz2?|efoo|esym)$/i.test(name)) return true;
  if (/\.json$/i.test(name)) return easyedaStdType(head) > 0;
  if (/\.zip$/i.test(name)) return head.startsWith('PK') && (ZIP_MARK.test(head) || /BackupProjects|ProProject/i.test(name));
  return false;
}

export function listEasyeda(files: { path: string; bytes?: Uint8Array }[]): ImportItem[] {
  const out: ImportItem[] = [];
  for (const f of files) {
    const n = f.path;
    if (/\.(epro2?)$/i.test(n)) out.push({ path: n, kind: 'Project' });
    else if (/\.(elibz2?)$/i.test(n)) out.push({ path: n, kind: 'Library' });
    else if (/\.efoo$/i.test(n)) out.push({ path: n, kind: 'Footprint' });
    else if (/\.esym$/i.test(n)) out.push({ path: n, kind: 'Symbol' });
    else if (/\.zip$/i.test(n)) out.push({ path: n, kind: 'Project' });
    else if (/\.json$/i.test(n)) {
      const t = f.bytes ? easyedaStdType(td.decode(f.bytes.subarray(0, 4096))) : 0;
      const kind = t === 3 ? 'PCB' : t === 4 ? 'Footprint' : t === 5 || t === 1 ? 'Schematic' : t === 2 ? 'Symbol' : '';
      if (kind) out.push({ path: n, kind });
    }
  }
  return out;
}

interface StdDoc { path: string; doc: Record<string, unknown>; type: number; group: string }

/** Standard's documents of a file: JSON, or a backup's (zips within zips). */
async function stdDocs(path: string, bytes: Uint8Array, group: string, depth = 0): Promise<StdDoc[]> {
  if (isZip(bytes)) {
    if (depth > 3) return [];
    const out: StdDoc[] = [];
    for (const e of unzipEntries(bytes)) {
      if (e.name.endsWith('/') || !/\.(json|zip)$/i.test(e.name)) continue;
      out.push(...await stdDocs(e.name, await e.data(), depth === 0 ? group : `${group}/${baseName(path)}`, depth + 1));
    }
    return out;
  }
  const text = td.decode(bytes).replace(/^﻿/, '');
  if (!easyedaStdType(text.slice(0, 4096))) return [];
  try { const doc = JSON.parse(text) as Record<string, unknown>; return [{ path, doc, type: easyedaDocType(doc), group }]; } catch { return []; }
}

export async function importEasyeda(files: ImportFile[], opts: ImportOptions = {}): Promise<ImportResult> {
  const out: ImportResult = { projects: [], libraries: [], messages: [] };
  const std: StdDoc[] = [];
  for (const f of files) {
    if (opts.only && !opts.only.has(f.path)) continue;
    const name = baseName(f.path);
    try {
      if (/\.json$/i.test(name) || (/\.zip$/i.test(name) && !isEasyedaPro(name, f.bytes))) { std.push(...await stdDocs(f.path, f.bytes, isZip(f.bytes) ? f.path : '')); continue; }
      if (!isEasyedaPro(name, f.bytes)) continue;
      opts.progress?.(`${stemOf(name)}: reading`);
      await yieldNow();
      const p = await readEasyedaPro(name, f.bytes);
      await importPro(p, name, out, opts);
    } catch (e) { out.messages.push({ level: 'error', source: stemOf(name), message: `Not imported: ${(e as Error).message}` }); }
  }
  if (std.length) await importStd(std, out, opts);
  return out;
}

/* ── Standard ── */

async function importStd(docs: StdDoc[], out: ImportResult, opts: ImportOptions): Promise<void> {
  // A schematic and a board of one backup, or of one name, are one project
  const groups = new Map<string, { name: string; sch: StdDoc[]; pcb: StdDoc[] }>();
  for (const d of docs) {
    if (d.type === 4) {
      const r = convertEasyedaPcb(d.doc, baseName(d.path));
      if (r.footprints.length) out.libraries.push({ name: `${safe(r.name)}.PcbLib`, bytes: ipcFootprintLibrary(r.footprints, `${safe(r.name)}.PcbLib`) });
      continue;
    }
    if (d.type === 2) { out.messages.push({ level: 'warn', source: stemOf(d.path), message: 'EasyEDA Standard symbol documents are not imported (place them in a schematic first)' }); continue; }
    if (d.type !== 3 && d.type !== 5 && d.type !== 1) continue;
    const stem = stemOf(d.path).replace(/^PCB_/i, '');
    const key = d.group || stem.toLowerCase();
    const g = groups.get(key) ?? { name: d.group ? stemOf(d.group).replace(/_[0-9a-f]{32}$/i, '').replace(/^BackupProjects_/i, '') : stem, sch: [], pcb: [] };
    (d.type === 3 ? g.pcb : g.sch).push(d);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const name = safe(g.name);
    const documents: ImportedDoc[] = [];
    const prj = newPrjPcb(`${name}.PrjPcb`);
    try {
      g.sch.forEach((d, i) => {
        opts.progress?.(`${name}: schematic`);
        const stem = g.sch.length > 1 ? `${name}_${i + 1}` : name;
        const r = convertEasyedaSch(d.doc, `${stem}.json`, g.pcb.length ? `${name}.PcbLib` : '');
        documents.push(...r.sheets, { name: `${stem}.SchLib`, bytes: r.library });
        iniSet(prj, 'Design', 'HierarchyMode', '3');
        out.messages.push({ level: 'info', source: name, message: `Schematics: ${r.stats.sheets} sheet${r.stats.sheets === 1 ? '' : 's'}, ${r.stats.parts} parts, ${r.stats.nets} named nets; ${r.stats.symbols} symbols` });
        for (const w of r.warnings) out.messages.push({ level: 'warn', source: name, message: w });
      });
      g.pcb.forEach((d, i) => {
        opts.progress?.(`${name}: board`);
        const stem = g.pcb.length > 1 ? `${name}_${i + 1}` : name;
        const r = convertEasyedaPcb(d.doc, `${stem}.json`);
        documents.push({ name: `${stem}.PcbDoc`, bytes: r.bytes });
        if (r.footprints.length) documents.push({ name: `${stem}.PcbLib`, bytes: ipcFootprintLibrary(r.footprints, `${stem}.PcbLib`) });
        out.messages.push({ level: 'info', source: name, message: `Board: ${r.stats.layers} copper layers, ${r.stats.components} components, ${r.stats.pads} pads, ${r.stats.vias} vias, ${r.stats.tracks} tracks and arcs, ${r.stats.nets} nets; ${r.footprints.length} footprints` });
        for (const w of r.warnings) out.messages.push({ level: 'warn', source: name, message: w });
      });
      for (const d of documents) addDocument(prj, d.name);
      out.projects.push({ name, prj: { name: `${name}.PrjPcb`, bytes: writePrjPcb(prj) }, documents });
    } catch (e) { out.messages.push({ level: 'error', source: name, message: `Not imported: ${(e as Error).message}` }); }
    await yieldNow();
  }
}

/* ── Pro ── */

async function importPro(p: ProProject, file: string, out: ImportResult, opts: ImportOptions): Promise<void> {
  const library = !p.schematics.size && !p.pcbs.size;
  if (library) {
    // A library (or a lone footprint or symbol): its SchLib and PcbLib
    const name = safe(p.title || stemOf(file));
    if (p.symbols.size) {
      const r = proSymbolLibrary(p);
      if (r.count) out.libraries.push({ name: `${name}.SchLib`, bytes: r.bytes });
      out.messages.push({ level: 'info', source: name, message: `Symbols: ${r.count}` });
      for (const w of r.warnings) out.messages.push({ level: 'warn', source: name, message: w });
    }
    if (p.footprints.size) {
      const r = proFootprintLibrary(p);
      out.libraries.push({ name: `${name}.PcbLib`, bytes: ipcFootprintLibrary(r.footprints, `${name}.PcbLib`) });
      out.messages.push({ level: 'info', source: name, message: `Footprints: ${r.footprints.length}` });
      for (const w of r.warnings) out.messages.push({ level: 'warn', source: name, message: w });
    }
    return;
  }
  // Each board a project; a schematic or PCB on no board a project of its own
  const jobs: { name: string; schematic?: string; pcb?: string }[] = p.boards.map((b) => ({ ...b }));
  const usedSch = new Set(jobs.map((j) => j.schematic)), usedPcb = new Set(jobs.map((j) => j.pcb));
  for (const [id, s] of p.schematics) if (!usedSch.has(id)) jobs.push({ name: s.name, schematic: id });
  for (const [id, d] of p.pcbs) if (!usedPcb.has(id)) jobs.push({ name: d.title, pcb: id });
  const taken = new Set<string>();
  const one = jobs.length === 1;
  for (const j of jobs) {
    let name = safe(one && /^Board\d*$/i.test(j.name) ? p.title || j.name : j.name);
    const base = name;
    for (let k = 2; taken.has(name.toLowerCase()); k++) name = `${base}_${k}`;
    taken.add(name.toLowerCase());
    const documents: ImportedDoc[] = [];
    const prj = newPrjPcb(`${name}.PrjPcb`);
    try {
      if (j.schematic && p.schematics.has(j.schematic)) {
        opts.progress?.(`${name}: schematic`);
        await yieldNow();
        const r = convertProSch(p, j.schematic, name, `${name}.PcbLib`);
        documents.push(...r.sheets, { name: `${name}.SchLib`, bytes: r.library });
        iniSet(prj, 'Design', 'HierarchyMode', '3');
        out.messages.push({ level: 'info', source: name, message: `Schematics: ${r.stats.sheets} page${r.stats.sheets === 1 ? '' : 's'}, ${r.stats.parts} parts, ${r.stats.nets} named nets; ${r.stats.symbols} symbols` });
        for (const w of r.warnings) out.messages.push({ level: 'warn', source: name, message: w });
      }
      if (j.pcb && p.pcbs.has(j.pcb)) {
        opts.progress?.(`${name}: board`);
        await yieldNow();
        const r = convertProPcb(p, p.pcbs.get(j.pcb)!, name);
        documents.push({ name: `${name}.PcbDoc`, bytes: r.bytes });
        if (r.footprints.length) documents.push({ name: `${name}.PcbLib`, bytes: ipcFootprintLibrary(r.footprints, `${name}.PcbLib`) });
        out.messages.push({ level: 'info', source: name, message: `Board: ${r.stats.layers} copper layers, ${r.stats.components} components, ${r.stats.pads} pads, ${r.stats.vias} vias, ${r.stats.tracks} tracks and arcs, ${r.stats.nets} nets; ${r.footprints.length} footprints` });
        for (const w of r.warnings) out.messages.push({ level: 'warn', source: name, message: w });
      } else if (j.schematic && p.footprints.size) {
        // No board: the footprints its parts name, as its PcbLib
        const want = new Set<string>();
        for (const pg of p.schematics.get(j.schematic)?.pages ?? []) for (const r of pg.recs) if (r[0] === 'ATTR' && r[3] === 'Footprint' && p.footprints.has(String(r[4]))) want.add(String(r[4]));
        for (const pg of p.schematics.get(j.schematic)?.pages ?? []) for (const r of pg.recs) if (r[0] === 'ATTR' && r[3] === 'Device') { const fp = p.devices.get(String(r[4]))?.attributes.Footprint; if (fp && p.footprints.has(fp)) want.add(fp); }
        if (want.size) {
          const lib = proFootprintLibrary(p, [...want]);
          documents.push({ name: `${name}.PcbLib`, bytes: ipcFootprintLibrary(lib.footprints, `${name}.PcbLib`) });
        }
      }
      if (!documents.length) continue;
      for (const d of documents) addDocument(prj, d.name);
      out.projects.push({ name, prj: { name: `${name}.PrjPcb`, bytes: writePrjPcb(prj) }, documents });
    } catch (e) { out.messages.push({ level: 'error', source: name, message: `Not imported: ${(e as Error).message}` }); }
  }
}
