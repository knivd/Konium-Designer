/**
 * Schematic annotation: propose designators for parts whose designator ends in '?', the way
 * Altium's Annotate Schematics does — by prefix, in the chosen order of processing, filling
 * multi-part packages before starting a new one, never reusing a designator already in use.
 */
import type { SheetInput } from './compile';
import { natural } from './compile';
import { partLetter, isShown, type SchObject } from './sch';
import type { PropertyBag } from '../formats/altium/props';

export type AnnotateOrder = 'upThenAcross' | 'downThenAcross' | 'acrossThenUp' | 'acrossThenDown';
export const ORDER_LABEL: Record<AnnotateOrder, string> = {
  upThenAcross: 'Up Then Across', downThenAcross: 'Down Then Across', acrossThenUp: 'Across Then Up', acrossThenDown: 'Across Then Down',
};

export interface AnnotateRow {
  sheet: string;
  componentIndex: number;
  designatorIndex: number | null;   // the DESIGNATOR text record to rewrite
  current: string;
  currentPart: number;
  proposed: string;
  libRef: string;
  partCount: number;
}

type Comp = SchObject & { kind: 'component' };

const subLetter = (part: number, count: number) => (count > 1 ? partLetter(part) : '');

export function planAnnotation(sheets: SheetInput[], order: AnnotateOrder = 'acrossThenDown', resetAll = false): AnnotateRow[] {
  const rows: AnnotateRow[] = [];
  const used = new Map<string, Set<number>>();              // prefix → numbers in use
  const note = (d: string) => {
    const m = /^(.*?)(\d+)$/.exec(d);
    if (!m) return;
    if (!used.has(m[1]!)) used.set(m[1]!, new Set());
    used.get(m[1]!)!.add(parseInt(m[2]!, 10));
  };
  const todo: { sheet: string; c: Comp; designatorIndex: number | null; sheetNo: number }[] = [];
  sheets.forEach(({ name, doc }, sheetNo) => {
    for (const o of doc.objects) {
      if (o.kind !== 'component' || !isShown(doc, o)) continue;
      const des = doc.objects.find((x) => x.owner === o.index && x.kind === 'text' && x.role === 'designator');
      const needs = resetAll || !o.designator || o.designator.includes('?');
      if (needs) todo.push({ sheet: name, c: o, designatorIndex: des?.index ?? null, sheetNo });
      else note(o.designator);
    }
  });
  const key = (t: typeof todo[number]) => {
    const { x, y } = t.c.at;
    switch (order) {
      case 'acrossThenDown': return [t.sheetNo, -y, x];
      case 'acrossThenUp': return [t.sheetNo, y, x];
      case 'downThenAcross': return [t.sheetNo, x, -y];
      case 'upThenAcross': return [t.sheetNo, x, y];
    }
  };
  todo.sort((a, b) => { const ka = key(a), kb = key(b); for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i]! - kb[i]!; return 0; });
  const next = (prefix: string) => {
    if (!used.has(prefix)) used.set(prefix, new Set());
    const s = used.get(prefix)!;
    let n = 1;
    while (s.has(n)) n++;
    s.add(n);
    return n;
  };
  // Open multi-part packages, matched the way Annotate's default Matching Options do (Comment
  // and Library Reference): key → { designator, parts used }
  const commentOf = (t: typeof todo[number]) => {
    const { doc } = sheets[t.sheetNo]!;
    const o = doc.objects.find((x) => x.owner === t.c.index && x.kind === 'text' && x.role === 'parameter' && doc.records[x.index + 1]?.bag?.get('NAME')?.toLowerCase() === 'comment');
    return o?.kind === 'text' ? o.text : '';
  };
  const packages = new Map<string, { des: string; used: Set<number>; count: number }[]>();
  for (const t of todo) {
    const prefix = (t.c.designator || 'U?').replace(/\?.*$/, '').replace(/\d+$/, '') || 'U';
    const count = Math.max(1, t.c.partCount - 1);
    let des: string;
    if (count > 1) {
      const k = `${t.c.libRef}\u0000${commentOf(t)}`.toLowerCase();
      const list = packages.get(k) ?? [];
      packages.set(k, list);
      let pkg = list.find((p) => !p.used.has(t.c.partId));
      if (!pkg) { pkg = { des: `${prefix}${next(prefix)}`, used: new Set(), count }; list.push(pkg); }
      pkg.used.add(t.c.partId);
      des = pkg.des;
    } else des = `${prefix}${next(prefix)}`;
    rows.push({
      sheet: t.sheet, componentIndex: t.c.index, designatorIndex: t.designatorIndex,
      current: t.c.designator, currentPart: t.c.partId, proposed: des, libRef: t.c.libRef, partCount: count,
    });
  }
  return rows;
}

export const subPart = (row: AnnotateRow) => subLetter(row.currentPart, row.partCount);
export { natural };

/** "C12" → "C?", "U3" → "U?": the designator's prefix with Altium's unannotated mark. */
/**
 * Reset Parts Designators On Paste (Preferences › Schematic › Graphical Editing): the designators
 * of pasted parts go back to their prefix and '?' (R12 → R?), ready for Annotate Quietly.
 * items are the clipboard entries (owner = index within items); bags are what will be added.
 */
export function resetPastedDesignators(items: readonly { bag: PropertyBag; owner: number }[], bags: PropertyBag[]): void {
  items.forEach((it, k) => {
    if (it.owner < 0 || it.bag.get('RECORD') !== '34' || items[it.owner]?.bag.get('RECORD') !== '1') return;
    const t = bags[k]!.get('TEXT');
    if (t && !t.endsWith('?')) bags[k]!.set('TEXT', resetDesignator(t));
  });
}

export function resetDesignator(d: string): string {
  const prefix = d.replace(/\?.*$/, '').replace(/\d+$/, '');
  return `${prefix || 'U'}?`;
}

/**
 * Tools › Annotation › Reset Schematic Designators / Reset Duplicate Schematic Designators:
 * rows that set designators back to their prefix form (R?, C?, U?). For duplicates, the first
 * part with a designator (sheet order, then reading order on the sheet) keeps it; parts of one
 * multi-part package share a designator legitimately and only clash when the same part repeats.
 */
export function planReset(sheets: SheetInput[], duplicatesOnly = false): AnnotateRow[] {
  const rows: AnnotateRow[] = [];
  const seen = new Set<string>();
  sheets.forEach(({ name, doc }) => {
    const comps = doc.objects.filter((o): o is Comp => o.kind === 'component' && isShown(doc, o))
      .sort((a, b) => b.at.y - a.at.y || a.at.x - b.at.x);
    for (const c of comps) {
      if (!c.designator || c.designator.includes('?')) continue;
      const count = Math.max(1, c.partCount - 1);
      const id = `${c.designator}\u0000${count > 1 ? c.partId : 0}`;
      const dup = seen.has(id);
      seen.add(id);
      if (duplicatesOnly && !dup) continue;
      const des = doc.objects.find((x) => x.owner === c.index && x.kind === 'text' && x.role === 'designator');
      rows.push({ sheet: name, componentIndex: c.index, designatorIndex: des?.index ?? null, current: c.designator, currentPart: c.partId,
        proposed: resetDesignator(c.designator), libRef: c.libRef, partCount: count });
    }
  });
  return rows;
}
