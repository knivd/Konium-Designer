/**
 * Integrated Library projects (.LibPkg): the package's schematic and PCB libraries, compiled by
 * Project › Compile Integrated Library into <Package>.IntLib in the project outputs, as AD17's.
 * Compiling checks that each component's footprints are in the package's PCB libraries.
 */
import { readSchLib } from '../formats/altium/schlib';
import { readPcbLib } from '../formats/altium/pcblib';
import { packIntLib } from '../formats/altium/intlib';
import { docBaseName, isLibPkgName } from '../formats/altium/prjpcb';
import { save } from '../formats/registry';
import { SR } from '../model/sch';
import { deliverOutputs } from './dialogs/Outputs';
import { cmdCompile } from './project';
import { docs, notify, replaceMessages, type Project } from './state';
import { showPanel } from './dock/store';

export const isLibPkg = (p: Project | null | undefined): boolean => !!p && isLibPkgName(p.name);

/** A project document's bytes as they are now: the open tab's (edits included), else the file's. */
export function currentBytes(p: Project, path: string): Uint8Array | null {
  const name = docBaseName(path);
  const od = docs.value.find((d) => d.projectId === p.id && d.name.toLowerCase() === name.toLowerCase());
  if (od) {
    try { return od.editor ? od.editor.withToolSuspended(() => save(od.doc)) : save(od.doc); } catch { return od.bytes; }
  }
  return p.files.get(name.toLowerCase())?.bytes ?? null;
}

/** What compiling the package finds: its libraries and the problems. */
export function checkLibPkg(p: Project): { libs: { kind: 'SchLib' | 'PcbLib'; name: string; bytes: Uint8Array }[]; problems: { level: 'warn' | 'error'; doc: string; message: string }[]; components: number; footprints: number } {
  const libs: { kind: 'SchLib' | 'PcbLib'; name: string; bytes: Uint8Array }[] = [];
  const problems: { level: 'warn' | 'error'; doc: string; message: string }[] = [];
  const footprints = new Set<string>();
  const symbols: { lib: string; libRef: string; models: string[] }[] = [];
  for (const path of p.prj.documents) {
    const name = docBaseName(path);
    const kind = /\.schlib$/i.test(name) ? 'SchLib' : /\.pcblib$/i.test(name) ? 'PcbLib' : null;
    if (!kind) continue;
    const bytes = currentBytes(p, path);
    if (!bytes) { problems.push({ level: 'error', doc: p.name, message: `Source library ${name} not found` }); continue; }
    try {
      if (kind === 'SchLib') {
        for (const s of readSchLib(bytes, name).symbols) {
          const models = s.bags.filter((b) => b.int('RECORD', -1) === SR.IMPLEMENTATION && (b.get('MODELTYPE') ?? '').toUpperCase() === 'PCBLIB').map((b) => b.get('MODELNAME') ?? '').filter(Boolean);
          symbols.push({ lib: name, libRef: s.libRef, models });
        }
      } else for (const f of readPcbLib(bytes, name).footprints) footprints.add(f.name.toLowerCase());
      libs.push({ kind, name, bytes });
    } catch (e) {
      problems.push({ level: 'error', doc: name, message: `${name} could not be read: ${(e as Error).message}` });
    }
  }
  if (!libs.some((l) => l.kind === 'SchLib')) problems.push({ level: 'error', doc: p.name, message: 'The package has no schematic library' });
  for (const s of symbols) {
    if (!s.models.length) problems.push({ level: 'warn', doc: s.lib, message: `Component ${s.libRef} has no footprint` });
    for (const m of s.models) if (!footprints.has(m.toLowerCase())) problems.push({ level: 'warn', doc: s.lib, message: `Footprint ${m} of ${s.libRef} not found in the package's PCB libraries` });
  }
  return { libs, problems, components: symbols.length, footprints: footprints.size };
}

/** Project › Compile Integrated Library: <Package>.IntLib into "Project Outputs for <Package>". */
export async function compileLibPkg(p: Project): Promise<boolean> {
  const r = checkLibPkg(p);
  const errors = r.problems.filter((x) => x.level === 'error').length;
  replaceMessages('Compiler', [
    ...r.problems.map((x) => ({ doc: x.doc, level: x.level, message: x.message })),
    { doc: p.name, level: errors ? 'error' as const : 'info' as const, message: errors ? `Compile halted: ${errors} error${errors > 1 ? 's' : ''}`
      : `Compile successful, ${r.components} components, ${r.footprints} footprints, ${r.problems.length} warning${r.problems.length === 1 ? '' : 's'}` },
  ]);
  if (r.problems.length) showPanel('messages');
  if (errors) { notify(`Compiled ${p.name}: ${errors} error${errors > 1 ? 's' : ''}`, 'error'); return false; }
  const base = p.name.replace(/\.libpkg$/i, '');
  const bytes = await packIntLib(r.libs);
  await deliverOutputs(p, base, 'Integrated Library', [{ name: `${base}.IntLib`, text: '', bytes }]);
  return true;
}

/** Compile whichever kind of project: a PCB project's schematics, a package's libraries. */
export function compileAny(p: Project | null): void {
  if (p && isLibPkg(p)) void compileLibPkg(p);
  else cmdCompile(p);
}

/** Project › Compile caption, as AD's: "Compile PCB Project X.PrjPcb" or "Compile Integrated Library X.LibPkg". */
export const compileCaption = (p: Project | null, accel = '&Compile'): string | undefined =>
  p ? `${accel} ${isLibPkg(p) ? 'Integrated Library' : 'PCB Project'} ${p.name}` : undefined;
