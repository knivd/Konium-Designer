/**
 * Project › Regenerate Harness Definitions: each sheet's harness connectors as its .Harness
 * file, one line per harness type in name order — `Type=Entry1,Entry2,{Entry3:SubType}` — the
 * entries in connector order, a nested harness as {entry:type}, as AD writes them (the first
 * connector of a type on the sheet defines it) [est: CRLF line ends].
 */
import { harnessType, isHarness } from './schHarness';
import type { SchDocument } from './sch';

export function harnessFileText(doc: SchDocument): string {
  const types = new Map<string, string[]>();
  for (const o of doc.objects) {
    if (!isHarness(o)) continue;
    const type = harnessType(doc, o.index);
    if (!type || [...types.keys()].some((t) => t.toLowerCase() === type.toLowerCase())) continue;
    const entries = doc.objects.filter((e) => e.kind === 'harnessentry' && e.owner === o.index)
      .sort((a, b) => (a.kind === 'harnessentry' && b.kind === 'harnessentry' ? a.distance - b.distance : 0))
      .map((e) => {
        const name = e.kind === 'harnessentry' ? e.name : '';
        const sub = doc.records[e.index + 1]?.bag?.get('HARNESSTYPE') ?? '';
        return sub ? `{${name}:${sub}}` : name;
      });
    types.set(type, entries);
  }
  return [...types].sort((a, b) => a[0].localeCompare(b[0], 'en', { sensitivity: 'base' })).map(([t, e]) => `${t}=${e.join(',')}\r\n`).join('');
}

/** A sheet's .Harness file name: its own name with the extension changed. */
export const harnessFileName = (sheet: string) => `${sheet.replace(/\.[^.]+$/, '')}.Harness`;

/** Read a .Harness file: each type's entries (nested ones as {entry:type}). */
export function readHarnessFile(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const entries: string[] = [];
    let depth = 0, cur = '';
    for (const ch of line.slice(eq + 1)) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
      if (ch === ',' && depth === 0) { entries.push(cur); cur = ''; } else cur += ch;
    }
    if (cur) entries.push(cur);
    out.set(line.slice(0, eq), entries);
  }
  return out;
}
