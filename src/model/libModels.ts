/**
 * The models of a library symbol (Tools › Model Manager): its IMPLEMENTATION records under the
 * component's IMPLEMENTATION_LIST — footprints (MODELTYPE PCBLIB) and anything else kept as is.
 * Changes are made on the symbol's view (a small schematic), so they undo like any edit.
 */
import { PropertyBag } from '../formats/altium/props';
import type { Change } from '../core/undo';
import { SR, bagOf, type SchDocument } from './sch';
import { addRecords, removeObjects, replaceBags, setProps, uniqueId } from './schEdit';

/** `library`: PCB Model › PCB Library, MODELDATAFILE0 (a library name, or a path) — '' for Any. */
export interface SymbolModel { index: number; name: string; type: string; description: string; current: boolean; footprint: boolean; library: string }

/**
 * A model record with its PCB Library set: MODELDATAFILE0 holds a Library name or a Library path
 * (AD17 writes it just before MODELDATAFILEENTITY0); '' clears it (Any).
 */
export function withModelLibrary(b: PropertyBag, file: string): PropertyBag {
  const out = b.clone();
  const entity = out.get('MODELDATAFILEENTITY0');
  if (entity === undefined) { if (file) out.set('MODELDATAFILE0', file); else out.delete('MODELDATAFILE0'); return out; }
  const pair: [string, string][] = [...(file ? [['MODELDATAFILE0', file] as [string, string]] : []), ['MODELDATAFILEENTITY0', entity]];
  out.replaceGroup((k) => k.toUpperCase() === 'MODELDATAFILE0' || k.toUpperCase() === 'MODELDATAFILEENTITY0', pair);
  return out;
}

/** A new footprint model record, its keys in AD17's order. */
export function footprintModelBag(owner: number, m: { name: string; description?: string; current?: boolean; useComponentLibrary?: boolean; library?: string }): PropertyBag {
  return PropertyBag.from({ RECORD: SR.IMPLEMENTATION, OWNERINDEX: owner, ...(m.useComponentLibrary ? { USECOMPONENTLIBRARY: 'T' } : {}), ...(m.description ? { DESCRIPTION: m.description } : {}),
    MODELNAME: m.name.trim(), MODELTYPE: 'PCBLIB', DATAFILECOUNT: 1, ...(m.library && !m.useComponentLibrary ? { MODELDATAFILE0: m.library } : {}),
    MODELDATAFILEENTITY0: m.name.trim(), MODELDATAFILEKIND0: 'PCBLib', ...(m.current ? { ISCURRENT: 'T' } : {}), UNIQUEID: uniqueId() });
}

const component = (view: SchDocument) => view.objects.find((o) => o.kind === 'component');

export function symbolModels(view: SchDocument): SymbolModel[] {
  const c = component(view);
  if (!c) return [];
  const lists = new Set(view.objects.filter((o) => o.owner === c.index && o.record === SR.IMPLEMENTATION_LIST).map((o) => o.index));
  return view.objects.filter((o) => o.record === SR.IMPLEMENTATION && lists.has(o.owner)).map((o) => {
    const b = bagOf(view, o)!;
    const t = (b.get('MODELTYPE') ?? '').toUpperCase();
    return { index: o.index, name: b.get('MODELNAME') ?? '', type: t === 'PCBLIB' ? 'Footprint' : t === 'SIM' ? 'Simulation' : t === 'PCB3DLIB' ? 'PCB3D' : b.get('MODELTYPE') ?? '', description: b.get('DESCRIPTION') ?? '', current: b.bool('ISCURRENT'), footprint: t === 'PCBLIB', library: b.get('MODELDATAFILE0') ?? '' };
  });
}

/** Add Footprint: a PCBLIB model (current when the symbol has no footprint yet); null when it already has one of that name. */
export function addFootprintChange(view: SchDocument, name: string, description = '', library = ''): Change | null {
  const c = component(view);
  if (!c || !name.trim()) return null;
  const have = symbolModels(view);
  if (have.some((m) => m.footprint && m.name.toLowerCase() === name.toLowerCase())) return null;
  const current = !have.some((m) => m.footprint);
  const bags: PropertyBag[] = [];
  const base = view.records.length - 1;
  let list = view.objects.find((o) => o.owner === c.index && o.record === SR.IMPLEMENTATION_LIST)?.index;
  if (list === undefined) { bags.push(PropertyBag.from({ RECORD: SR.IMPLEMENTATION_LIST, OWNERINDEX: c.index })); list = base; }
  const impl = base + bags.length;
  bags.push(footprintModelBag(list, { name, description, current, library }));
  bags.push(PropertyBag.from({ RECORD: SR.MAP_DEFINER_LIST, OWNERINDEX: impl }), PropertyBag.from({ RECORD: SR.IMPL_PARAMS, OWNERINDEX: impl }));
  return addRecords(view, bags);
}

/** Remove: the model and what it owns. */
export const removeModelChange = (view: SchDocument, index: number): Change => removeObjects(view, [index]);

/** Edit: name, description (the data file entity follows the name) and, given, the PCB Library. */
export function editModelChange(view: SchDocument, index: number, name: string, description: string, library?: string): Change | null {
  const b = view.records[index + 1]?.bag;
  if (!b) return null;
  let after = b.clone();
  if (name !== (b.get('MODELNAME') ?? '')) { after.set('MODELNAME', name); if (b.has('MODELDATAFILEENTITY0')) after.set('MODELDATAFILEENTITY0', name); }
  if (description !== (b.get('DESCRIPTION') ?? '')) { if (description) after.set('DESCRIPTION', description); else after.delete('DESCRIPTION'); }
  if (library !== undefined && library !== (b.get('MODELDATAFILE0') ?? '')) after = withModelLibrary(after, library);
  return JSON.stringify(after.toObject()) !== JSON.stringify(b.toObject()) ? replaceBags(view, [{ index, before: b.clone(), after }]) : null;
}

/** Set Current: this footprint becomes the one the part uses; the others stop being current. */
export function currentModelChanges(view: SchDocument, index: number): Change[] {
  return symbolModels(view).filter((m) => m.footprint && (m.index === index) !== m.current)
    .map((m) => setProps(view, m.index, { ISCURRENT: m.index === index ? 'T' : null }));
}
