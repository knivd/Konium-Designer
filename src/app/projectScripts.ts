/**
 * A project's scripts (R8): .js files in a Scripts folder beside the project file, when the
 * project is open from its folder. They travel with the project (version control commits them);
 * edits are written to the file as they are typed.
 */
import { signal } from '@preact/signals';
import { active, notify, projects, type Project } from './state';
import { projectFolder } from './actions';
import { touched } from './vcs';
import { ensurePermission, writeInto } from '../platform/fs';
import { fromFile, scriptFile } from '../scripting/store';
import type { ScriptDef } from '../scripting/examples';

export const SCRIPTS_FOLDER = 'Scripts';

/** Each project's scripts by project id, as last read or written. */
export const projectScripts = signal<Record<string, ScriptDef[]>>({});

/** The project whose scripts the Scripts panel shows: the document in front's, else the only one open. */
export function scriptProject(): Project | null {
  const pid = active.value?.projectId;
  return (pid ? projects.value.find((p) => p.id === pid) : undefined) ?? (projects.value.length === 1 ? projects.value[0]! : null);
}

async function scriptsDir(p: Project, create: boolean): Promise<FileSystemDirectoryHandle | null> {
  if (!p.dir) return null;
  try { return await (await projectFolder(p)).getDirectoryHandle(SCRIPTS_FOLDER, { create }); } catch (e) {
    if (create) throw e;
    return null;
  }
}

const keep = (p: Project, list: ScriptDef[]) => {
  projectScripts.value = { ...projectScripts.value, [p.id]: list.slice().sort((a, b) => a.name.localeCompare(b.name)) };
};
const listOf = (p: Project) => projectScripts.value[p.id] ?? [];

/** Read the project's Scripts folder again. */
export async function loadProjectScripts(p: Project): Promise<ScriptDef[]> {
  const d = await scriptsDir(p, false);
  const list: ScriptDef[] = [];
  if (d) {
    for await (const [name, h] of (d as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (h.kind !== 'file' || !/\.m?js$/i.test(name)) continue;
      const r = fromFile(name, await (await (h as FileSystemFileHandle).getFile()).text());
      list.push({ id: `p:${p.id}:${name}`, name: r.name, code: r.code, file: name, projectId: p.id });
    }
  }
  // An edit not yet written stays as typed
  for (const s of listOf(p)) if (timers.has(s.id)) { const i = list.findIndex((x) => x.id === s.id); if (i >= 0) list[i] = s; }
  keep(p, list);
  return list;
}

/** A script name no other script of the project has. */
export function freeProjectName(p: Project, want: string): string {
  const taken = new Set(listOf(p).map((s) => s.name.toLowerCase()));
  if (!taken.has(want.toLowerCase())) return want;
  for (let i = 2; ; i++) { const n = `${want} ${i}`; if (!taken.has(n.toLowerCase())) return n; }
}

/** A file name in the Scripts folder for a new script called `name`. */
function fileFor(p: Project, name: string): string {
  const safe = name.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Script';
  const taken = new Set(listOf(p).map((s) => s.file!.toLowerCase()));
  if (!taken.has(`${safe}.js`.toLowerCase())) return `${safe}.js`;
  for (let i = 2; ; i++) if (!taken.has(`${safe} ${i}.js`.toLowerCase())) return `${safe} ${i}.js`;
}

/** Write a script into the project's Scripts folder (a new file when `file` is not given). */
export async function saveProjectScript(p: Project, s: { file?: string; name: string; code: string }): Promise<ScriptDef> {
  if (!p.dir || !(await ensurePermission(p.dir))) throw new Error(`Konium Designer may not write to ${p.folder ?? 'the project’s folder'}`);
  const d = (await scriptsDir(p, true))!;
  const file = s.file ?? fileFor(p, s.name);
  await writeInto(d, file, new TextEncoder().encode(scriptFile({ id: '', name: s.name, code: s.code }).text));
  const def: ScriptDef = { id: `p:${p.id}:${file}`, name: s.name, code: s.code, file, projectId: p.id };
  keep(p, [...listOf(p).filter((x) => x.file !== file), def]);
  touched(p);
  return def;
}

/** An edit to a project's script: kept at once, written to its file after a pause in typing. */
const timers = new Map<string, ReturnType<typeof setTimeout>>();
export function editProjectScript(p: Project, def: ScriptDef, name: string, code: string): void {
  keep(p, listOf(p).map((x) => (x.id === def.id ? { ...x, name, code } : x)));
  clearTimeout(timers.get(def.id));
  timers.set(def.id, setTimeout(() => {
    timers.delete(def.id);
    void saveProjectScript(p, { file: def.file, name, code }).catch((e) => notify(`${def.file} wasn’t saved: ${(e as Error).message}`, 'error'));
  }, 600));
}

/** Delete a project's script file. */
export async function deleteProjectScript(p: Project, def: ScriptDef): Promise<void> {
  clearTimeout(timers.get(def.id));
  timers.delete(def.id);
  if (!p.dir || !(await ensurePermission(p.dir))) throw new Error(`Konium Designer may not change ${p.folder ?? 'the project’s folder'}`);
  await (await scriptsDir(p, false))?.removeEntry(def.file!);
  keep(p, listOf(p).filter((x) => x.id !== def.id));
  touched(p);
}
