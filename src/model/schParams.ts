/**
 * Parameters as Tools › Parameter Manager and Number Schematic Sheets edit them: a document's
 * own (RECORD 41 with no owner, or owned by the sheet record) and each part's. A missing
 * parameter is added hidden, as Altium adds it.
 */
import { PropertyBag } from '../formats/altium/props';
import type { Change } from '../core/undo';
import { SR, bagOf, isShown, ownedBy, type SchDocument, type SchObject } from './sch';
import { addRecords, setProps, uniqueId } from './schEdit';

const isDocOwner = (doc: SchDocument, i: number) => i < 0 || doc.objects[i]?.record === SR.SHEET;

export function docParam(doc: SchDocument, name: string): { index: number; value: string } | undefined {
  const k = name.toLowerCase();
  for (const o of doc.objects) {
    if (o.record !== SR.PARAMETER || !isDocOwner(doc, o.owner)) continue;
    const b = bagOf(doc, o);
    if (b?.get('NAME')?.toLowerCase() === k) return { index: o.index, value: b.get('TEXT') ?? '' };
  }
  return undefined;
}

/** Set a document parameter (added hidden when missing); null when it already has the value. */
export function docParamChange(doc: SchDocument, name: string, value: string): Change | null {
  const cur = docParam(doc, name);
  if (cur) return cur.value === value ? null : setProps(doc, cur.index, { TEXT: value });
  return addRecords(doc, [PropertyBag.from({ RECORD: SR.PARAMETER, OWNERPARTID: -1, ISHIDDEN: 'T', COLOR: 8388608, FONTID: 1, NAME: name, TEXT: value, UNIQUEID: uniqueId() })]);
}

export interface PartParams { index: number; designator: string; libRef: string; params: Map<string, { index: number; name: string; value: string }> }

/** Every part on the sheet (each multi-part package once per placed part) and its parameters. */
export function partParams(doc: SchDocument): PartParams[] {
  const out: PartParams[] = [];
  for (const o of doc.objects) if (o.kind === 'component' && isShown(doc, o)) out.push(paramsOf(doc, o.index));
  return out;
}

/** One part's parameters (from the records it owns). */
function paramsOf(doc: SchDocument, part: number): PartParams {
  const o = doc.objects[part] as SchObject & { kind: 'component' };
  const params = new Map<string, { index: number; name: string; value: string }>();
  for (const c of ownedBy(doc).get(part) ?? []) {
    if (c.record !== SR.PARAMETER) continue;
    const b = bagOf(doc, c), n = b?.get('NAME');
    if (n && !params.has(n.toUpperCase())) params.set(n.toUpperCase(), { index: c.index, name: n, value: b!.get('TEXT') ?? '' });
  }
  return { index: o.index, designator: o.designator, libRef: o.libRef, params };
}

/** Set a part's parameter (added hidden under the part when missing). */
export function partParamChange(doc: SchDocument, part: number, name: string, value: string): Change | null {
  if (doc.objects[part]?.kind !== 'component') return null;
  const p = paramsOf(doc, part);
  const cur = p.params.get(name.toUpperCase());
  if (cur) return cur.value === value ? null : setProps(doc, cur.index, { TEXT: value });
  const at = doc.objects[part];
  const loc = at && 'at' in at ? (at.at as { x: number; y: number }) : { x: 0, y: 0 };
  const b = PropertyBag.from({ RECORD: SR.PARAMETER, OWNERINDEX: part, OWNERPARTID: -1, ISHIDDEN: 'T', COLOR: 8388608, FONTID: 1, NAME: name, TEXT: value, UNIQUEID: uniqueId() });
  b.set('LOCATION.X', String(Math.round(loc.x / 100_000))); b.set('LOCATION.Y', String(Math.round(loc.y / 100_000)));
  return addRecords(doc, [b]);
}
