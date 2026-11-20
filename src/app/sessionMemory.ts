/**
 * What Konium remembers between sessions about what was open:
 * - each project's open documents (System › View › Restore open documents), by project;
 * - the projects and documents open when Konium was last closed (System › General › Reopen
 *   Last Workspace), by the folder and path each came from, to match the recent lists' handles.
 */
import { effect } from '@preact/signals';
import { readLocal, writeLocal } from '../core/storage';
import { signal } from '@preact/signals';
import { settings } from '../core/settings';
import type { RecentDocument, RecentProject } from '../platform/recent';
import { docs, projects, recentDocuments, recentProjects, type Project } from './state';

const DOCS_KEY = 'project.openDocs.v1', WS_KEY = 'workspace.last.v1';
const read = <T,>(k: string, d: T): T => { try { return (JSON.parse(readLocal(k) ?? 'null') as T) ?? d; } catch { return d; } };

/** A project's key: its folder and path when it came from one, else its name. */
export const projectKey = (p: Pick<Project, 'name' | 'dir' | 'path'>): string => (p.dir ? `${p.dir.name}/${p.path ?? p.name}` : p.name).toLowerCase();

let openDocs = read<Record<string, string[]>>(DOCS_KEY, {});
/** The documents a project had open when last seen, in tab order (lower case names). */
export const rememberedDocs = (p: Pick<Project, 'name' | 'dir' | 'path'>): string[] => openDocs[projectKey(p)] ?? [];

export interface LastWorkspace { projects: { folder: string; prjPath: string }[]; documents: string[] }
export const lastWorkspace = (): LastWorkspace => read<LastWorkspace>(WS_KEY, { projects: [], documents: [] });

let lastDocsJson = JSON.stringify(openDocs), lastWsJson = '';
/** Until the start has read the last workspace, an empty one isn't written over it. */
let armed = false;
export function armWorkspace(): void { armed = true; lastWsJson = ''; }
effect(() => {
  const all = docs.value, ps = projects.value;
  // Each open project's documents (a project with none open keeps what it last had)
  for (const p of ps) {
    const names = all.filter((d) => d.projectId === p.id && !d.hidden).map((d) => d.name.toLowerCase());
    if (names.length) openDocs[projectKey(p)] = names;
  }
  const j = JSON.stringify(openDocs);
  if (j !== lastDocsJson) { lastDocsJson = j; writeLocal(DOCS_KEY, j); }
  // The workspace: projects from folders, documents opened from disk on their own
  const ws: LastWorkspace = {
    projects: ps.filter((p) => p.dir && p.path).map((p) => ({ folder: p.dir!.name, prjPath: p.path! })),
    documents: all.filter((d) => !d.projectId && d.handle && !d.hidden).map((d) => d.name),
  };
  const w = JSON.stringify(ws);
  if (w !== lastWsJson && (armed || ws.projects.length || ws.documents.length)) { lastWsJson = w; writeLocal(WS_KEY, w); }
});

/** The last workspace's projects and documents the browser must be asked about first (a click on the Home page). */
export const pendingWorkspace = signal<{ projects: RecentProject[]; documents: RecentDocument[] } | null>(null);

type Perm = { queryPermission?: (o: { mode: string }) => Promise<string> };
const granted = async (h: unknown): Promise<boolean> => { try { return (await (h as Perm).queryPermission?.({ mode: 'readwrite' })) === 'granted'; } catch { return false; } };

/**
 * At the start (System › General › Reopen Last Workspace): the projects and documents open when
 * Konium was last closed, from the recent lists' kept handles — at once where the browser still
 * allows them, else offered on the Home page.
 */
export async function reopenLastWorkspace(reopenProject: (r: RecentProject) => Promise<void>, reopenDocument: (r: RecentDocument) => Promise<void>): Promise<void> {
  const ws = lastWorkspace();
  armWorkspace();
  if (!settings.reopenWorkspace || (!ws.projects.length && !ws.documents.length)) return;
  const rp = recentProjects.value.filter((r) => ws.projects.some((w) => w.folder === r.folder && w.prjPath.toLowerCase() === r.prjPath.toLowerCase()));
  const rd = recentDocuments.value.filter((r) => ws.documents.some((n) => n.toLowerCase() === r.name.toLowerCase()));
  const askP: RecentProject[] = [], askD: RecentDocument[] = [];
  for (const r of rp) { if (await granted(r.dir)) await reopenProject(r); else askP.push(r); }
  for (const r of rd) { if (await granted(r.handle)) await reopenDocument(r); else askD.push(r); }
  if (askP.length || askD.length) pendingWorkspace.value = { projects: askP, documents: askD };
}
