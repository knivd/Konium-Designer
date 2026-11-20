/**
 * Edit › Find Text and Replace Text on schematics, as Altium Designer 17 does them: the text of
 * net labels, power ports, ports, sheet entries, off-sheet connectors (net identifiers),
 * designators, parameters, text strings, text frames, notes and sheet symbol names, matched
 * case-sensitively or not, whole words or anywhere, with * and ? wildcards.
 */
import { SR, bagOf, type SchDocument, type SchObject } from './sch';

export type Identifiers = 'all' | 'nets' | 'designators';
export interface FindOptions { text: string; caseSensitive: boolean; wholeWords: boolean; identifiers: Identifiers }
export interface TextHit { index: number; key: 'TEXT' | 'NAME'; value: string }

const NET_RECORDS = new Set<number>([SR.NET_LABEL, SR.POWER_PORT, SR.PORT, SR.SHEET_ENTRY]);
const TEXT_RECORDS: Record<number, 'TEXT' | 'NAME'> = {
  [SR.NET_LABEL]: 'TEXT', [SR.POWER_PORT]: 'TEXT', [SR.PORT]: 'NAME', [SR.SHEET_ENTRY]: 'NAME', [SR.DESIGNATOR]: 'TEXT', [SR.PARAMETER]: 'TEXT',
  [SR.LABEL]: 'TEXT', [SR.TEXT_FRAME]: 'TEXT', [SR.NOTE]: 'TEXT', [SR.SHEET_NAME]: 'TEXT', [SR.FILE_NAME]: 'TEXT',
};

/** The search as a regular expression (Altium's wildcards: * any run, ? one character). */
export function findPattern(o: Pick<FindOptions, 'text' | 'caseSensitive' | 'wholeWords'>, global = false): RegExp | null {
  if (!o.text) return null;
  const body = o.text.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*?').replace(/\?/g, '.');
  return new RegExp(o.wholeWords ? `(?<![\\w])${body}(?![\\w])` : body, `${o.caseSensitive ? '' : 'i'}${global ? 'g' : ''}`);
}

function textOf(doc: SchDocument, o: SchObject): TextHit | null {
  const key = TEXT_RECORDS[o.record];
  if (!key) return null;
  const b = bagOf(doc, o);
  const v = b?.get(key);
  if (v === undefined || v === '') return null;
  return { index: o.index, key, value: key === 'TEXT' && (o.record === SR.TEXT_FRAME || o.record === SR.NOTE) ? v.replace(/~1/g, '\n') : v };
}

/** Every text that matches, in reading order (top to bottom, left to right). */
export function findText(doc: SchDocument, o: FindOptions, only?: Set<number>): TextHit[] {
  const re = findPattern(o);
  if (!re) return [];
  const hits: (TextHit & { y: number; x: number })[] = [];
  for (const obj of doc.objects) {
    if (only && !only.has(obj.index)) continue;
    if (o.identifiers === 'nets' && !NET_RECORDS.has(obj.record)) continue;
    if (o.identifiers === 'designators' && obj.record !== SR.DESIGNATOR) continue;
    const t = textOf(doc, obj);
    if (!t || !re.test(t.value)) continue;
    const at = 'at' in obj ? obj.at : 'a' in obj ? obj.a : { x: 0, y: 0 };
    hits.push({ ...t, x: at.x, y: at.y });
  }
  return hits.sort((a, b) => b.y - a.y || a.x - b.x).map(({ index, key, value }) => ({ index, key, value }));
}

/** The text after replacing every match in it. */
export function replaceIn(value: string, o: FindOptions, by: string): string {
  const re = findPattern(o, true);
  return re ? value.replace(re, () => by) : value;
}
