/**
 * Project and workspace commands of 26.042, as AD17's WorkspaceManager has them: Save Design
 * Workspace, Create Projects from Path, Add New Project (PCB Project, Integrated Library),
 * Add New to Project › Other, Remove All (a folder of the Projects tree), Explore, All Recent
 * Documents and Projects, Document Options and Component Links of a right-clicked document,
 * Regenerate Harness Definitions and the Project Packager.
 */
import type { Command } from '../core/commands';
import { addDocument, docBaseName, iniGet, newLibPkg, newPrjPcb, removeDocument, writePrjPcb } from '../formats/altium/prjpcb';
import { save } from '../formats/registry';
import { harnessFileName, harnessFileText } from '../model/harnessFile';
import { projectsFromPath, relativeTo, writeDsnWrk, type PathProject } from '../model/designWorkspace';
import { packFiles, type PackSource } from '../model/packager';
import { collectAll, collectFromDirectory, ensurePermission, requestProjectFolder, saveFile, saveFileAs, writeInto, type PickedFile } from '../platform/fs';
import { cmdNewDocument, cmdNewPcb, cmdNewPcbLib, cmdNewSchLib, nextId, openDocument, projectFolder } from './actions';
import { commands } from '../core/commands';
import { showDialog } from './dialogs';
import { ConfirmDialog } from './dialogs/Confirm';
import { NewProjectDialog, defaultProjectName } from './dialogs/NewProject';
import { CreateProjectsDialog, ExploreDialog, NewOtherDialog, ProjectPackagerDialog, RecentAllDialog } from './dialogs/Workspace42';
import { projectSheets, whenMounted } from './project';
import { activeId, currentProjectId, docs, isDocDirty, log, markProjectDirty, notify, projects, recentDocuments, recentProjects, replaceMessages, workspace, type OpenDoc, type Project } from './state';
import { focusedDocument, focusedProject, focusCategory, newDocTarget } from './workspace';
import { showPanel } from './dock/store';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { PcbLibEditor } from '../editors/pcb/PcbLibEditor';
import { componentLinks } from './syncCommands';

/* ─── Design Workspace ───────────────────────────────────────────────────────────────── */

/** Where a project's file is relative to the workspace file, when both are in one opened folder. */
async function pathFromWorkspace(p: Project, ws: FileSystemFileHandle | undefined): Promise<string | null> {
  if (!ws || !p.dir || !p.path) return null;
  try {
    const at = await p.dir.resolve(ws);
    return at ? relativeTo(at.join('/'), p.path) : null;
  } catch { return null; }
}

/** File › Save Design Workspace: the open projects into the workspace file (asked for the first time). */
export async function saveWorkspace(as = false): Promise<void> {
  const list = projects.value;
  if (!list.length) { notify('Open or create a project first: a workspace lists projects', 'error'); return; }
  const enc = new TextEncoder();
  const draft = () => enc.encode(writeDsnWrk(list.map((p) => p.path ?? p.name)));
  let h = as ? undefined : workspace.value.handle;
  try {
    if (!h) {
      const got = await saveFileAs(workspace.value.name, draft(), list.find((p) => p.dir)?.dir);
      if (got === null) return;
      h = got;
    }
    const paths: string[] = [], unknown: string[] = [];
    for (const p of list) {
      const rel = await pathFromWorkspace(p, h);
      if (rel === null) unknown.push(p.name);
      paths.push(rel ?? p.path?.replace(/\//g, '\\') ?? p.name);
    }
    const bytes = enc.encode(writeDsnWrk(paths));
    if (h) await saveFile(h.name, bytes, h);
    workspace.value = { name: h?.name ?? workspace.value.name, handle: h };
    if (unknown.length && h) log(workspace.value.name, [{ level: 'warn', message: `${unknown.join(', ')} ${unknown.length > 1 ? 'aren\'t' : 'isn\'t'} in a folder under the workspace's: listed by its path in its own folder` }]);
    notify(`Saved ${workspace.value.name}: ${list.length} project${list.length > 1 ? 's' : ''}`);
  } catch (e) {
    notify(`Couldn't save the workspace: ${(e as Error).message}`, 'error');
  }
}

/** Create Projects from Path: a project for each folder of design documents that has none. */
async function createProjectsFromPath(): Promise<void> {
  let dir: FileSystemDirectoryHandle | null;
  try { dir = await requestProjectFolder(); } catch (e) { notify(`Couldn't open the folder selector: ${(e as Error).message}`, 'error'); return; }
  if (!dir) return;
  const files = await collectFromDirectory(dir, 4);
  const found = projectsFromPath(files.map((f) => ({ path: f.path ?? f.name })), dir.name);
  if (!found.length) { notify(`No folder in “${dir.name}” holds design documents without a project`); return; }
  const root = dir;
  showDialog(CreateProjectsDialog, { root: dir.name, found, onOk: (chosen: PathProject[]) => addPathProjects(root, files, chosen) });
}

export function addPathProjects(dir: FileSystemDirectoryHandle | undefined, files: PickedFile[], chosen: PathProject[]): Project[] {
  const made: Project[] = [];
  for (const c of chosen) {
    const prj = /\.libpkg$/i.test(c.name) ? newLibPkg(c.name) : newPrjPcb(c.name);
    const p: Project = { id: nextId('p'), name: c.name, prj, files: new Map(), folder: dir?.name, dir, path: c.folder ? `${c.folder}/${c.name}` : c.name, dirty: true };
    for (const d of c.documents) {
      addDocument(prj, d);
      const f = files.find((x) => (x.path ?? x.name).toLowerCase() === (c.folder ? `${c.folder}/${d}` : d).toLowerCase());
      if (f) p.files.set(d.toLowerCase(), { ...f, path: d });
    }
    made.push(p);
  }
  if (!made.length) return made;
  projects.value = [...projects.value, ...made];
  currentProjectId.value = made[0]!.id;
  showPanel('projects');
  notify(`${made.length} project${made.length > 1 ? 's' : ''} created: save ${made.length > 1 ? 'them' : 'it'} to keep ${made.length > 1 ? 'them' : 'it'}`);
  return made;
}

/** Add New Project › PCB Project / Integrated Library: a new, unsaved project in the workspace, as AD adds it. */
function addNewProject(kind: 'PrjPcb' | 'LibPkg'): void {
  const name = `${defaultProjectName(kind)}.${kind}`;
  const prj = kind === 'LibPkg' ? newLibPkg(name) : newPrjPcb(name);
  const p: Project = { id: nextId('p'), name, prj, files: new Map(), dirty: true };
  projects.value = [...projects.value, p];
  currentProjectId.value = p.id;
  showPanel('projects');
  notify(`Added ${name}: save it to keep it`);
}

/* ─── Folders and documents of the Projects tree ─────────────────────────────────────── */

/** Remove All: the folder's documents leave the project (the files are kept; open ones stay as free documents). */
function removeCategory(): void {
  const c = focusCategory();
  if (!c || !c.paths.length) { notify('Right-click a folder of a project', 'error'); return; }
  const p = c.project;
  showDialog(ConfirmDialog, {
    title: 'Confirm', message: `Remove ${c.paths.length} document${c.paths.length > 1 ? 's' : ''} from ${p.name}?`, detail: 'The files themselves are kept; open documents stay open as free documents.',
    onYes: () => {
      for (const path of c.paths) {
        removeDocument(p.prj, path);
        const name = docBaseName(path).toLowerCase();
        p.files.delete(name);
        for (const d of docs.value) if (d.projectId === p.id && d.name.toLowerCase() === name) d.projectId = undefined;
      }
      docs.value = [...docs.value];
      markProjectDirty(p);
      notify(`Removed ${c.paths.length} document${c.paths.length > 1 ? 's' : ''} from ${p.name}`);
    },
  });
}

/** The folder a document, project or the workspace is in, and the path shown for it. */
async function folderOf(what: 'document' | 'project' | 'workspace'): Promise<{ dir: FileSystemDirectoryHandle; label: string } | null> {
  const f = focusedDocument();
  const p = what === 'document' ? f?.project ?? focusedProject() : what === 'project' ? focusedProject() : projects.value.find((x) => x.dir) ?? null;
  if (!p?.dir) return null;
  let dir = await projectFolder(p);
  const label = [p.folder ?? p.dir.name, ...(p.path ?? '').split('/').slice(0, -1)];
  if (what === 'document' && f) {
    const path = p.prj.documents.find((d) => docBaseName(d).toLowerCase() === f.name.toLowerCase()) ?? f.path ?? '';
    for (const seg of path.split('/').slice(0, -1).filter(Boolean)) { try { dir = await dir.getDirectoryHandle(seg); label.push(seg); } catch { break; } }
  }
  if (what === 'workspace') return { dir: p.dir, label: p.folder ?? p.dir.name };
  return { dir, label: label.filter(Boolean).join('\\') };
}

async function explore(what: 'document' | 'project' | 'workspace'): Promise<void> {
  const at = await folderOf(what);
  if (!at) { notify(what === 'workspace' ? 'No project of the workspace was opened from a folder' : 'Konium Designer has no folder for it: open the project from its folder', 'error'); return; }
  if (!(await ensurePermission(at.dir, 'read'))) { notify(`Access to “${at.label}” wasn't granted`, 'error'); return; }
  showDialog(ExploreDialog, { dir: at.dir, label: at.label, project: what === 'workspace' ? null : (what === 'document' ? focusedDocument()?.project : null) ?? focusedProject() });
}

/** Document Options of a right-clicked document: opened (or brought forward), then its options. */
function documentOptions(): void {
  const f = focusedDocument();
  const p = f?.project ?? null;
  const od = f ? docs.value.find((d) => d.name.toLowerCase() === f.name.toLowerCase() && (d.projectId ?? null) === (p?.id ?? null))
    ?? (p ? openDocument(p.files.get(f.name.toLowerCase()) ?? { name: f.name, bytes: new Uint8Array() }, p.id) : null) : null;
  if (!od?.editor) { notify(`${f?.name ?? 'The document'} isn't loaded`, 'error'); return; }
  const ed = od.editor;
  activeId.value = od.id;
  whenMounted(ed, () => {
    const id = ed instanceof PcbLibEditor ? 'ad:PCB:LibraryOptions' : ed instanceof PcbEditor ? 'ad:PCB:DesignOptions' : 'ad:WorkspaceManager:ConfigureOptionsActiveDocument';
    commands.get(id)?.run();
  });
}

/* ─── Regenerate Harness Definitions ─────────────────────────────────────────────────── */

async function regenerateHarness(p: Project | null): Promise<void> {
  if (!p) { notify('Open a project first', 'error'); return; }
  const sheets = projectSheets(p);
  const written: string[] = [];
  const enc = new TextEncoder();
  let folder: FileSystemDirectoryHandle | null = null;
  if (p.dir) { try { if (await ensurePermission(p.dir)) folder = await projectFolder(p); } catch { folder = null; } }
  for (const s of sheets) {
    const text = harnessFileText(s.doc);
    if (!text) continue;
    const name = harnessFileName(s.name);
    const sheetPath = p.prj.documents.find((d) => docBaseName(d).toLowerCase() === s.name.toLowerCase()) ?? s.name;
    const path = [...sheetPath.split('/').slice(0, -1), name].join('/');
    const bytes = enc.encode(text);
    if (!p.prj.documents.some((d) => docBaseName(d).toLowerCase() === name.toLowerCase())) { addDocument(p.prj, path); markProjectDirty(p); }
    p.files.set(name.toLowerCase(), { name, bytes, path });
    if (folder) {
      try {
        let d = folder;
        for (const seg of path.split('/').slice(0, -1)) d = await d.getDirectoryHandle(seg, { create: true });
        await writeInto(d, name, bytes);
      } catch (e) { notify(`Couldn't write ${name}: ${(e as Error).message}`, 'error'); }
    }
    written.push(name);
  }
  if (!written.length) { notify('No harness connectors with a Harness Type in the project'); return; }
  replaceMessages('Harness Definitions', written.map((n) => ({ doc: p.name, level: 'info' as const, message: `Harness definitions written to ${n}` })));
  notify(`${written.length} harness definition file${written.length > 1 ? 's' : ''} regenerated${folder ? '' : ' (kept in the project until it is packaged or saved from a folder)'}`);
}

/* ─── Project Packager ───────────────────────────────────────────────────────────────── */

/** What the packager can put in: the project file, its documents as they are now, and the folder's other files. */
export async function packSource(p: Project): Promise<PackSource> {
  const current = new Map<string, { bytes: Uint8Array; dirty: boolean }>();
  for (const od of docs.value.filter((d: OpenDoc) => d.projectId === p.id)) {
    try { current.set(od.name.toLowerCase(), { bytes: od.editor ? od.editor.withToolSuspended(() => save(od.doc)) : save(od.doc), dirty: isDocDirty(od) }); } catch { /* inspection-only: its file */ }
  }
  let folder: { path: string; bytes: Uint8Array }[] = [];
  if (p.dir) {
    try {
      if (await ensurePermission(p.dir, 'read')) folder = (await collectAll(await projectFolder(p))).map((f) => ({ path: f.path ?? f.name, bytes: f.bytes }));
    } catch { folder = []; }
  }
  return { name: p.name, prj: writePrjPcb(p.prj), documents: p.prj.documents, outputPath: iniGet(p.prj, 'Design', 'OutputPath'), folder, files: p.files, current };
}

async function projectPackager(p: Project | null): Promise<void> {
  if (!p) { notify('Open a project first', 'error'); return; }
  const files = packFiles(await packSource(p));
  showDialog(ProjectPackagerDialog, { project: p, files });
}

/* ─── Commands ───────────────────────────────────────────────────────────────────────── */

export function workspaceFileCommands(): Command[] {
  const hasProject = () => !!focusedProject();
  const newIn = (fn: (p: Project | null) => void) => () => fn(newDocTarget());
  return [
    { id: 'ad:WorkspaceManager:SaveWorkspace', label: 'Save Design Workspace', run: () => saveWorkspace(), enabled: () => projects.value.length > 0 },
    { id: 'ad:WorkspaceManager:CreateProjectsFromPath', label: 'Create Projects from Path...', run: createProjectsFromPath },
    { id: 'ad:WorkspaceManager:InsertNewProject', label: 'Add New Project...', run: () => showDialog(NewProjectDialog, {}) },
    { id: 'ad:WorkspaceManager:NewProject_PCB', label: 'PCB Project', run: () => addNewProject('PrjPcb') },
    { id: 'ad:WorkspaceManager:NewProject_LIB', label: 'Integrated Library', run: () => addNewProject('LibPkg') },
    { id: 'ad:WorkspaceManager:NewOther', label: 'Other', run: () => showDialog(NewOtherDialog, { project: newDocTarget(), make: {
      SchDoc: newIn((p) => cmdNewDocument('SchDoc', p)), PcbDoc: newIn(cmdNewPcb), SchLib: newIn(cmdNewSchLib), PcbLib: newIn(cmdNewPcbLib),
      OutJob: () => commands.get('ad:WorkspaceManager:NewJob')?.run(), Draftsman: () => commands.get('file.newDraftsman')?.run(), Diagram: () => commands.get('file.newDiagram')?.run(),
      ReqDoc: () => commands.get('file.newRequirements')?.run(),
    } }) },
    { id: 'ad:WorkspaceManager:RemoveFocusedCategory', label: 'Remove All...', run: removeCategory, enabled: () => !!focusCategory()?.paths.length },
    { id: 'ad:WorkspaceManager:ExploreToFocusedDocument', label: 'Explore', run: () => explore('document'), enabled: () => !!(focusedDocument()?.project ?? focusedProject())?.dir },
    { id: 'ad:WorkspaceManager:ExploreToFocusedProject', label: 'Explore', run: () => explore('project'), enabled: () => !!focusedProject()?.dir },
    { id: 'ad:WorkspaceManager:ExploreToWorkspace', label: 'Explore', run: () => explore('workspace'), enabled: () => projects.value.some((p) => !!p.dir) },
    { id: 'ad:WorkspaceManager:OpenAnyRecentDocument', label: 'All Recent Documents and Projects', run: () => showDialog(RecentAllDialog, {}), enabled: () => recentProjects.value.length + recentDocuments.value.length > 0 },
    { id: 'ad:WorkspaceManager:ConfigureOptionsFocusedDocument', label: 'Document Options...', run: documentOptions, enabled: () => /\.(schdoc|pcbdoc|schlib|pcblib)$/i.test(focusedDocument()?.name ?? '') },
    { id: 'ad:WorkspaceManager:ComponentLinkingFocused', label: 'Component Links...', run: () => componentLinks(focusedProject()), enabled: () => !!focusedProject() },
    { id: 'ad:WorkspaceManager:RegenerateProjectHarnessDefinitions', label: 'Regenerate Harness Definitions', run: () => regenerateHarness(focusedProject()), enabled: hasProject },
    { id: 'ad:WorkspaceManager:Archive', label: 'Project Packager...', run: () => projectPackager(focusedProject()), enabled: hasProject },
  ];
}
