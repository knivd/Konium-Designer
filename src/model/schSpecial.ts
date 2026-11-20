import { SR, bagOf, type SchDocument } from './sch';

/**
 * Schematic special strings: a text, parameter or text frame whose text starts with '=' shows
 * the value it names — '=Title', '=SheetNumber', '=Value' on a part's comment — or several
 * joined with '+' and quoted literals ("='Rev '+Revision"). Names are matched without regard
 * to case. Where a value comes from, first to last: the document's own facts (DocumentName,
 * DocumentFullPathAndName, CurrentDate, CurrentTime, ProjectName), the part's parameters (for
 * text belonging to a part), the document's parameters, the project's parameters, then the
 * sheet size. A name with no value shows nothing, or itself when Preferences › Schematic ›
 * Graphical Editing › Display Names of Special Strings that have No Value Set is on.
 */
export interface SpecialContext {
  docName: string;
  path?: string;
  projectName?: string;
  projectParams?: ReadonlyMap<string, string>;
  /** Values that come before every other (a compiled sheet's own sheet and document numbers). */
  overrides?: ReadonlyMap<string, string>;
}

export const SHEET_SIZES = ['A4', 'A3', 'A2', 'A1', 'A0', 'A', 'B', 'C', 'D', 'E', 'Letter', 'Legal', 'Tabloid', 'OrCAD A', 'OrCAD B', 'OrCAD C', 'OrCAD D', 'OrCAD E'];

/** Parameters (RECORD 41) owned by the given object, or by the document (no owner, or the sheet record). */
export function parametersOf(doc: SchDocument, owner: number | 'document'): Map<string, string> {
  const out = new Map<string, string>();
  const isDocOwner = (i: number) => i < 0 || doc.objects[i]?.record === SR.SHEET;
  for (const o of doc.objects) {
    if (o.record !== SR.PARAMETER) continue;
    if (owner === 'document' ? !isDocOwner(o.owner) : o.owner !== owner) continue;
    const bag = bagOf(doc, o);
    const name = bag?.get('NAME');
    if (name && !out.has(name.toUpperCase())) out.set(name.toUpperCase(), bag!.get('TEXT') ?? '');
  }
  return out;
}

/** Split "='Rev '+Revision" into literals and names. */
export function specialTerms(text: string): ({ literal: string } | { name: string })[] {
  const out: ({ literal: string } | { name: string })[] = [];
  let i = 1;
  while (i <= text.length) {
    while (text[i] === ' ') i++;
    if (text[i] === "'") {
      const end = text.indexOf("'", i + 1);
      const e = end < 0 ? text.length : end;
      out.push({ literal: text.slice(i + 1, e) });
      i = e + 1;
      while (text[i] === ' ') i++;
      if (text[i] === '+') i++;
      else if (i < text.length) { out.push({ literal: text.slice(i) }); break; }
      continue;
    }
    const plus = text.indexOf('+', i);
    const e = plus < 0 ? text.length : plus;
    let name = text.slice(i, e).trim();
    if (name.length > 1 && name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
    if (name) out.push({ name });
    if (plus < 0) break;
    i = plus + 1;
  }
  return out;
}

export type SpecialResolver = (text: string, owner: number) => string;

/** A resolver for one document as it is now (build it again after an edit). */
export function specialResolver(doc: SchDocument, ctx: SpecialContext, showNames: boolean, now = new Date()): SpecialResolver {
  const docParams = parametersOf(doc, 'document');
  const partParams = new Map<number, Map<string, string>>();
  const style = doc.records.find((r) => r.bag?.int('RECORD', -1) === SR.SHEET)?.bag;
  const system: Record<string, () => string | undefined> = {
    DOCUMENTNAME: () => ctx.docName,
    DOCUMENTFULLPATHANDNAME: () => ctx.path ?? ctx.docName,
    CURRENTDATE: () => now.toLocaleDateString(),
    CURRENTTIME: () => now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    PROJECTNAME: () => ctx.projectName?.replace(/\.prjpcb$/i, ''),
  };
  const sheetSize = () => (style?.bool('USECUSTOMSHEET') ? 'Custom' : SHEET_SIZES[style?.int('SHEETSTYLE') ?? 0]);
  const value = (name: string, owner: number): string | undefined => {
    const k = name.toUpperCase();
    const over = ctx.overrides?.get(k);
    if (over !== undefined) return over;
    const sys = system[k]?.();
    if (sys !== undefined) return sys;
    if (owner >= 0 && doc.objects[owner]?.kind === 'component') {
      let m = partParams.get(owner);
      if (!m) { m = parametersOf(doc, owner); partParams.set(owner, m); }
      const v = m.get(k);
      if (v !== undefined) return v;
    }
    const v = docParams.get(k) ?? ctx.projectParams?.get(k);
    if (v !== undefined) return v;
    if (k === 'SHEETSIZE' || k === 'PAPERSIZE') return sheetSize();
    return undefined;
  };
  return (text, owner) => {
    if (!text.startsWith('=') || text.length < 2) return text;
    let out = '', missing = false;
    for (const t of specialTerms(text)) {
      if ('literal' in t) { out += t.literal; continue; }
      const v = value(t.name, owner);
      if (v === undefined) missing = true; else out += v;
    }
    return missing && showNames ? text : out;
  };
}
