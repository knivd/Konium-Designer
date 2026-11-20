/**
 * Your scripts (R8): kept in this browser with Konium Designer's other settings, and read from
 * and written to .js files (Import, Export) to share them or keep them with a project.
 */
import { signal } from '@preact/signals';
import { readLocal, writeLocal } from '../core/storage';
import { EXAMPLES, type ScriptDef } from './examples';

const KEY = 'scripts';

function load(): ScriptDef[] {
  try {
    const v = JSON.parse(readLocal(KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((s): s is ScriptDef => !!s && typeof s.id === 'string' && typeof s.name === 'string' && typeof s.code === 'string').map((s) => ({ id: s.id, name: s.name, code: s.code })) : [];
  } catch { return []; }
}

/** Your own scripts (the examples are not among them). */
export const userScripts = signal<ScriptDef[]>(load());

function keep(list: ScriptDef[]): void {
  userScripts.value = list;
  writeLocal(KEY, JSON.stringify(list.map(({ id, name, code }) => ({ id, name, code }))));
}

/** Every script: yours first, then the examples. */
export function allScripts(): ScriptDef[] { return [...userScripts.value, ...EXAMPLES]; }
export function scriptById(id: string): ScriptDef | undefined { return allScripts().find((s) => s.id === id); }

/** A name not yet taken ("Script 2", "Net report (copy)" …). */
export function freeName(want: string): string {
  const taken = new Set(allScripts().map((s) => s.name.toLowerCase()));
  if (!taken.has(want.toLowerCase())) return want;
  for (let i = 2; ; i++) { const n = `${want} ${i}`; if (!taken.has(n.toLowerCase())) return n; }
}

/** Save a script of yours (a new one when `id` is not one of yours); its id back. */
export function saveScript(s: { id?: string; name: string; code: string }): string {
  const list = userScripts.value.slice();
  const i = s.id ? list.findIndex((x) => x.id === s.id) : -1;
  const name = s.name.trim() || 'Script';
  if (i >= 0) { list[i] = { id: list[i]!.id, name, code: s.code }; keep(list); return list[i]!.id; }
  const id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  list.unshift({ id, name: freeName(name), code: s.code });
  keep(list);
  return id;
}

export function deleteScript(id: string): void { keep(userScripts.value.filter((s) => s.id !== id)); }

/** A script file's text: its name on the first line, as a comment (read back by Import). */
export function scriptFile(s: ScriptDef): { name: string; text: string } {
  const safe = s.name.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Script';
  return { name: `${safe}.js`, text: `// @name ${s.name}\n${s.code.replace(/^\/\/ @name .*\n/, '')}` };
}

/** A .js file read as a script: its name from its "// @name" line, else the file's. */
export function fromFile(fileName: string, text: string): { name: string; code: string } {
  const m = /^\/\/ @name (.+)\r?\n/.exec(text);
  return { name: (m?.[1] ?? fileName.replace(/\.(m?js|txt)$/i, '')).trim(), code: m ? text.slice(m[0].length) : text };
}
