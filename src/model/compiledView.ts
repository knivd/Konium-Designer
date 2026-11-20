/**
 * A sheet as compiled, for one of its instances (Preferences › Schematic › Compiler › Compiled
 * Names Expansion): what the compile named each object there — a part's designator in its
 * channel, the net a net label, port, sheet entry or power port joins — and the sheet's number
 * among all the instances. Shown read-only in the tabs under a compiled sheet.
 */
import type { CompiledProject } from './compile';
import type { SchDocument } from './sch';
import { parametersOf } from './schSpecial';

export interface CompiledLook { inst: string; names: Map<number, string>; specials: Map<string, string> }
export interface ExpandWhat { designators: boolean; netLabels: boolean; ports: boolean; power: boolean; documentNumber: boolean; sheetNumber: boolean }

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** The instances a sheet was compiled as (once for a plain sheet; once per channel for a repeated one). */
export function compiledInstances(res: CompiledProject, sheet: string): string[] {
  const s = sheet.toLowerCase(), out = new Set<string>();
  for (const c of res.components) c.refs.forEach((r, i) => { if (r.sheet.toLowerCase() === s) out.add(c.refInsts?.[i] ?? c.inst ?? sheet); });
  for (const n of res.nets) for (const r of n.instRefs ?? []) if (r.ref.sheet.toLowerCase() === s) out.add(r.inst || sheet);
  return [...out].sort(natural);
}

/** Every instance of every sheet, in order: a sheet's number in the compiled design. */
export function allInstances(res: CompiledProject, sheets: string[]): string[] {
  return sheets.flatMap((s) => compiledInstances(res, s).map((i) => `${s.toLowerCase()}|${i}`));
}

export function compiledLook(res: CompiledProject, doc: SchDocument, sheet: string, inst: string, what: ExpandWhat, sheets: string[]): CompiledLook {
  const s = sheet.toLowerCase(), names = new Map<number, string>();
  if (what.designators) {
    for (const c of res.components) c.refs.forEach((r, i) => {
      if (r.sheet.toLowerCase() !== s || (c.refInsts?.[i] ?? c.inst ?? sheet) !== inst) return;
      for (const o of doc.objects) if (o.kind === 'text' && o.role === 'designator' && o.owner === r.index) names.set(o.index, c.designator);
    });
  }
  for (const n of res.nets) for (const r of n.instRefs ?? []) {
    if (r.ref.sheet.toLowerCase() !== s || (r.inst || sheet) !== inst) continue;
    const o = doc.objects[r.ref.index];
    if (!o) continue;
    if (o.kind === 'text' && o.role === 'netlabel' ? what.netLabels : o.kind === 'port' || o.kind === 'sheetentry' ? what.ports : o.kind === 'power' ? what.power : false) names.set(o.index, n.name);
  }
  const specials = new Map<string, string>();
  const all = allInstances(res, sheets), at = all.indexOf(`${s}|${inst}`);
  if (what.sheetNumber && at >= 0) { specials.set('SHEETNUMBER', String(at + 1)); specials.set('SHEETTOTAL', String(all.length)); }
  if (what.documentNumber && inst !== sheet) specials.set('DOCUMENTNUMBER', `${parametersOf(doc, 'document').get('DOCUMENTNUMBER') ?? ''}_${inst}`);
  return { inst, names, specials };
}

