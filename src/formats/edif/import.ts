/**
 * EDIF 2 0 0 files into AD projects (Import Wizard › EDIF, File › Open, drops): each file a project
 * of its schematic pages (a SchDoc each) and the SchLib of its cells. Schematic views come in as
 * drawn; a netlist view (Konium's own EDIF for PCB, an FPGA tool's netlist) as parts drawn in rows
 * with their nets named at their pins. The sheets are compiled on the way and their nets compared
 * with EDIF's joined ports; a difference is reported.
 */
import { addDocument, iniSet, newPrjPcb, writePrjPcb } from '../altium/prjpcb';
import type { ImportFile, ImportItem, ImportOptions, ImportResult } from '../importers';
import { readSchDoc } from '../altium/schdoc';
import { compileProject } from '../../model/compile';
import { isEdifText, readEdif } from './read';
import { convertEdif } from './sch';
import { breathe } from '../../core/breathe';

const td = new TextDecoder();
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const stemOf = (p: string) => baseName(p).replace(/\.[^.]+$/, '');
const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, '_').trim() || 'EDIF';
const yieldNow = breathe;
const EXT = /\.(edf|edn|edif|edo|edi|eds)$/i;

/** EDIF is told by how it begins, whatever the file is called (xDX Designer writes .eds, other tools .edf, .edn, .edif, .net). */
export const takesEdif = (_name: string, head: string): boolean => isEdifText(head);
export function listEdif(files: { path: string; bytes?: Uint8Array }[]): ImportItem[] {
  return files.filter((f) => (f.bytes ? isEdifText(td.decode(f.bytes.subarray(0, 4096))) : EXT.test(f.path))).map((f) => {
    if (!f.bytes) return { path: f.path, kind: 'EDIF' };
    const t = td.decode(f.bytes);
    return { path: f.path, kind: /\(\s*viewType\s+SCHEMATIC/i.test(t) ? 'Schematic' : 'Netlist' };
  });
}

export async function importEdif(files: ImportFile[], opts: ImportOptions = {}): Promise<ImportResult> {
  const out: ImportResult = { projects: [], libraries: [], messages: [] };
  for (const f of files) {
    if (opts.only && !opts.only.has(f.path)) continue;
    const head = td.decode(f.bytes.subarray(0, 4096));
    if (!takesEdif(baseName(f.path), head)) continue;
    const name = safe(stemOf(f.path));
    try {
      opts.progress?.(`${name}: reading`);
      await yieldNow();
      const doc = readEdif(td.decode(f.bytes));
      opts.progress?.(`${name}: schematics`);
      await yieldNow();
      const r = convertEdif(doc, name);
      const prj = newPrjPcb(`${name}.PrjPcb`);
      const documents = [...r.sheets, { name: `${name}.SchLib`, bytes: r.library }];
      for (const d of documents) addDocument(prj, d.name);
      iniSet(prj, 'Design', 'HierarchyMode', String(r.scope));
      out.messages.push({ level: 'info', source: name, message: `${doc.program ? `From ${doc.program}: ` : ''}${r.stats.sheets} sheet${r.stats.sheets === 1 ? '' : 's'}, ${r.stats.parts} parts, ${r.stats.nets} nets; ${r.stats.symbols} symbols` });
      for (const w of r.warnings) out.messages.push({ level: 'warn', source: name, message: w });
      // The sheets' nets against EDIF's (flat designs)
      if (r.expected) {
        const c = compileProject(r.sheets.map((s) => ({ name: s.name, doc: readSchDoc(s.bytes, s.name) })), { scope: r.scope as 2 | 3 });
        const netOfPin = new Map<string, string>();
        for (const n of c.nets) for (const p of n.pins) netOfPin.set(`${p.designator}-${p.pin}`, n.name);
        const bad: string[] = [];
        for (const [net, pins] of r.expected) {
          const got = new Set([...pins].map((p) => netOfPin.get(p) ?? '?'));
          if (pins.size > 1 && (got.size !== 1 || got.has('?'))) bad.push(net);
        }
        if (bad.length) out.messages.push({ level: 'warn', source: name, message: `${bad.length} net${bad.length === 1 ? '' : 's'} drawn otherwise than EDIF joins them: ${bad.slice(0, 6).join(', ')}${bad.length > 6 ? ' …' : ''}` });
      }
      out.projects.push({ name, prj: { name: `${name}.PrjPcb`, bytes: writePrjPcb(prj) }, documents });
    } catch (e) { out.messages.push({ level: 'error', source: name, message: `Not imported: ${(e as Error).message}` }); }
  }
  return out;
}
