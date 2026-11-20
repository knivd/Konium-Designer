/**
 * Design › Templates: a sheet template (.SchDot) is a schematic whose graphics, text and
 * parameters are copied into the sheet under one TEMPLATE record (RECORD 39, FILENAME), each
 * owned by it; the sheet record names the file (TEMPLATEFILENAME). Removing a template takes
 * that record and everything under it away. The template's sheet size and border come along.
 */
import type { Change } from '../core/undo';
import { PropertyBag } from '../formats/altium/props';
import { SR, bagOf, type SchDocument } from './sch';
import { addRecords, removeObjects, setProps } from './schEdit';

/** The template record on a sheet, if any. */
export const templateOf = (doc: SchDocument) => doc.objects.find((o) => o.record === SR.TEMPLATE);

/** Keys of the sheet record a template sets. */
const SHEET_KEYS = ['SHEETSTYLE', 'USECUSTOMSHEET', 'CUSTOMX', 'CUSTOMY', 'CUSTOMXZONES', 'CUSTOMYZONES', 'CUSTOMMARGINWIDTH', 'WORKSPACEORIENTATION',
  'BORDERON', 'TITLEBLOCKON', 'REFERENCEZONESON', 'DOCUMENTBORDERSTYLE'];

/** A change built when first applied (its records depend on what earlier steps left). */
function lazy(make: () => Change | null): Change {
  let inner: Change | null | undefined;
  return { apply() { inner ??= make(); inner?.apply(); }, revert() { inner?.revert(); } };
}

export function removeTemplateChanges(doc: SchDocument): Change[] {
  const t = templateOf(doc);
  const sheet = doc.objects.find((o) => o.record === SR.SHEET);
  const out: Change[] = [];
  if (t) out.push(removeObjects(doc, [t.index]));
  if (sheet) out.push(lazy(() => {
    const s = doc.objects.find((o) => o.record === SR.SHEET);
    return s && bagOf(doc, s)?.has('TEMPLATEFILENAME') ? setProps(doc, s.index, { TEMPLATEFILENAME: null }) : null;
  }));
  return out;
}

/** Replace the sheet's template with the one in tpl (a .SchDot read as a schematic). */
export function applyTemplateChanges(doc: SchDocument, tpl: SchDocument, fileName: string): Change[] {
  const out = removeTemplateChanges(doc);
  // The template's own objects: everything but its sheet record, owners renumbered under the new record
  const src = tpl.objects.filter((o) => o.record !== SR.SHEET && o.record !== SR.HEADER && bagOf(tpl, o));
  out.push(lazy(() => {
    const base = doc.records.length - 1;
    const map = new Map<number, number>(src.map((o, i) => [o.index, base + 1 + i]));
    const bags = [PropertyBag.from({ RECORD: SR.TEMPLATE, ISNOTACCESIBLE: true, OWNERPARTID: -1, FILENAME: fileName })];
    for (const o of src) {
      const b = bagOf(tpl, o)!.clone();
      const own = b.has('OWNERINDEX') ? map.get(b.int('OWNERINDEX')) : undefined;
      b.set('OWNERINDEX', String(own ?? base));
      if (own === undefined) b.set('OWNERPARTID', '1');
      bags.push(b);
    }
    return addRecords(doc, bags);
  }));
  out.push(lazy(() => {
    const s = doc.objects.find((o) => o.record === SR.SHEET);
    const tb = tpl.records.find((r) => r.bag?.int('RECORD', -1) === SR.SHEET)?.bag;
    if (!s) return null;
    const props: Record<string, string | null> = { TEMPLATEFILENAME: fileName, SHOWTEMPLATEGRAPHICS: 'T' };
    for (const k of SHEET_KEYS) props[k] = tb?.has(k) ? tb.get(k)! : null;
    return setProps(doc, s.index, props);
  }));
  return out;
}
