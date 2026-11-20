/**
 * The Projects and Messages panels' commands, as Altium's WorkspaceManager has them: they act on
 * the item that was right-clicked (the "focused" project, document or folder, or the selected
 * message), falling back to the active document's project when run from the menu bar.
 * Hiding a document takes its tab away but keeps it open, edits and undo included, as Altium does.
 */
import { locale } from '../core/locale';
import { effect, signal } from '@preact/signals';
import type { Command } from '../core/commands';
import { docBaseName } from '../formats/altium/prjpcb';
import { router } from './commands';
import { askSave, cmdClose, cmdSave, cmdSaveProject, openDocument } from './actions';
import { settings } from '../core/settings';
import { activeProject, cmdCompile } from './project';
import { compileAny, compileCaption } from './libPkg';
import { currentProject, currentProjectId, isDocDirty, active, activeId, docs, messages, notify, projects, type Message, type OpenDoc, type Project } from './state';
import { saveFileAs } from '../platform/fs';
import { showDialog } from './dialogs';
import { MessageInfoDialog } from './dialogs/Workspace42';
import { printHtml } from './print';
import { messagesReportHtml, type MsgGroup } from './messagesReport';
export { msgGroupKey, type MsgGroup } from './messagesReport';

/* ─── What was right-clicked ─────────────────────────────────────────────────────────── */

export interface CtxFocus {
  project?: Project | null;
  /** A document row: its project (null for a free document), file name and open tab if any. */
  doc?: { project: Project | null; name: string; path?: string };
  /** A folder row: the documents under it. */
  category?: { project: Project; paths: string[] };
}
let focus: CtxFocus = {};
let gen = 0;
/** The tree row the last right-click went to, highlighted while its menu is open. */
export const ctxRow = signal<string | null>(null);

export function setCtxFocus(f: CtxFocus, row: string | null = null): void { focus = f; gen++; ctxRow.value = row; }
/** A menu closing forgets the focus once its command has run (commands run in the same task). */
export function bindCtxFocus(): void {
  router.chain.on((st) => {
    if (st) return;
    const g = gen;
    setTimeout(() => { if (g === gen) { focus = {}; ctxRow.value = null; } }, 0);
  });
}

/** The right-clicked folder row (its project and the documents under it). */
export const focusCategory = (): CtxFocus['category'] => focus.category;
/** The right-clicked document row (its project, name and path). */
export const focusedDocument = (): CtxFocus['doc'] => focus.doc;
/** Where a new document goes: the project right-clicked (Add New to Project), else the focused project. */
export const newDocTarget = (): Project | null =>
  focus.project !== undefined ? focus.project : focus.doc ? focus.doc.project : focus.category ? focus.category.project : currentProject();
/** The project a command acts on: the one right-clicked, else the active document's, else the current one (only project when there is one). */
export const focusedProject = (): Project | null => focus.project ?? focus.doc?.project ?? focus.category?.project ?? activeProject() ?? currentProject() ?? (projects.value.length === 1 ? projects.value[0]! : null);
const openTab = (p: Project | null, name: string): OpenDoc | undefined =>
  docs.value.find((d) => d.name.toLowerCase() === name.toLowerCase() && (d.projectId ?? null) === (p?.id ?? null));
const focusedDoc = (): OpenDoc | undefined => (focus.doc ? openTab(focus.doc.project, focus.doc.name) : active.value ?? undefined);
/** The open document a right-click went to (a tab or a Projects row), else the active one. */
export const focusedOpenDoc = focusedDoc;
const projectPaths = (p: Project) => p.prj.documents;

/* ─── Hidden documents ───────────────────────────────────────────────────────────────── */

const refresh = () => { docs.value = [...docs.value]; };
/** Tabs shown: open documents that aren't hidden. */
export const visibleDocs = (): OpenDoc[] => docs.value.filter((d) => !d.hidden);

export function hideDocs(list: OpenDoc[]): void {
  if (!list.length) return;
  for (const d of list) d.hidden = true;
  if (active.value?.hidden) activeId.value = visibleDocs().filter((d) => !list.includes(d)).at(-1)?.id ?? null;
  refresh();
}
// Activating a hidden document (Projects panel, Window menu, cross-probe) shows its tab again
effect(() => {
  const d = active.value;
  if (d?.hidden) { d.hidden = false; queueMicrotask(refresh); }
});

/** Open a project document by path, optionally without focusing it. */
function openPath(p: Project, path: string, focusIt: boolean): OpenDoc | null {
  const name = docBaseName(path);
  const open = openTab(p, name);
  if (open) { if (focusIt) activeId.value = open.id; return open; }
  const f = p.files.get(name.toLowerCase());
  if (!f) return null;
  return openDocument(f, p.id, focusIt);
}
function openPaths(p: Project, paths: string[]): void {
  const avail = paths.filter((x) => p.files.has(docBaseName(x).toLowerCase()));
  if (!avail.length) { notify('These documents weren\'t loaded: open the project folder', 'error'); return; }
  avail.forEach((x, i) => openPath(p, x, i === 0));
}
const tabsOf = (p: Project, paths: string[]) => paths.map((x) => openTab(p, docBaseName(x))).filter((d): d is OpenDoc => !!d);
/** Close tabs one by one; false if the user kept one (unsaved changes). */
async function closeTabs(list: OpenDoc[]): Promise<boolean> {
  for (const d of list) if (!(await cmdClose(d))) return false;
  return true;
}
async function saveTabs(list: OpenDoc[]): Promise<void> { for (const d of list) if (isDocDirty(d)) await cmdSave(d); }

/** Close a project: its tabs first (each asks if unsaved), then the project file itself if it has unsaved changes. */
export async function closeProject(p: Project | null): Promise<boolean> {
  if (!p) return false;
  if (!(await closeTabs(docs.value.filter((d) => d.projectId === p.id)))) return false;
  if (p.dirty && settings.confirmClose) {
    const a = await askSave(p.name);
    if (a === 'cancel' || (a === 'yes' && !(await cmdSaveProject(p)))) return false;
  }
  projects.value = projects.value.filter((x) => x !== p);
  if (currentProjectId.value === p.id) currentProjectId.value = projects.value[0]?.id ?? null;
  return true;
}

/* ─── Messages ───────────────────────────────────────────────────────────────────────── */

/** The selected message (its number). */
export const msgSel = signal<number | null>(null);
/** Messages › Group By: one list, or a heading per class, document or source. */
export const msgGroup = signal<MsgGroup>('none');
/** Group headings folded away (by their key). */
export const msgFolded = signal<Set<string>>(new Set());
const selMessage = (): Message | undefined => messages.value.find((m) => m.no === msgSel.value);
const msgText = (m: Message) => [m.cls ?? `[${m.level === 'warn' ? 'Warning' : m.level === 'error' ? 'Error' : 'Info'}]`, m.doc, m.source, m.message,
  new Date(m.at).toLocaleTimeString(locale()), new Date(m.at).toLocaleDateString(locale()), String(m.no)].join('\t');
const msgClass = (m: Message) => m.cls ?? m.level;

function stepMessage(dir: 1 | -1): void {
  const list = messages.value.filter((m) => m.locate);
  if (!list.length) { notify('No messages to cross probe'); return; }
  const i = list.findIndex((m) => m.no === msgSel.value);
  const next = list[i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length]!;
  msgSel.value = next.no;
  next.locate?.();
}
async function saveMessages(list: Message[]): Promise<void> {
  if (!list.length) { notify('No messages to save'); return; }
  const text = ['Class\tDocument\tSource\tMessage\tTime\tDate\tNo.', ...list.map(msgText)].join('\r\n');
  const h = await saveFileAs('Messages.txt', new TextEncoder().encode(text));
  if (h) notify('Messages saved');
}

/* ─── Commands ───────────────────────────────────────────────────────────────────────── */

const hasProject = () => !!focusedProject();
const hasDoc = () => !!focus.doc || !!active.value;

export function workspaceCommands(): Command[] {
  return [
    { id: 'wm.compileProject', label: 'Compile Project', caption: () => compileCaption(focusedProject()),
      run: () => compileAny(focusedProject()), enabled: hasProject },
    { id: 'wm.recompileProject', label: 'Recompile Project', caption: () => compileCaption(focusedProject(), '&Recompile'),
      run: () => compileAny(focusedProject()), enabled: hasProject },
    { id: 'tools.recompile', label: 'Recompile Project', caption: () => compileCaption(activeProject(), '&Recompile'),
      run: () => { const p = activeProject(); if (p) compileAny(p); else cmdCompile(); } },
    { id: 'wm.saveProject', label: 'Save Project', run: async () => {
      const p = focusedProject();
      if (!p) return;
      await saveTabs(docs.value.filter((d) => d.projectId === p.id));
      if (p.dirty) await cmdSaveProject(p);
    }, enabled: hasProject },
    { id: 'wm.openProjectDocs', label: 'Open Project Documents', run: () => { const p = focusedProject(); if (p) openPaths(p, projectPaths(p)); }, enabled: hasProject },
    { id: 'wm.hideProjectDocs', label: 'Hide All In Project', run: () => { const p = focusedProject(); if (p) hideDocs(docs.value.filter((d) => d.projectId === p.id)); }, enabled: hasProject },
    { id: 'wm.closeProjectDocs', label: 'Close Project Documents', run: () => { const p = focusedProject(); if (p) closeTabs(docs.value.filter((d) => d.projectId === p.id)); }, enabled: hasProject },
    { id: 'wm.closeProject', label: 'Close Project', run: () => closeProject(focusedProject()), enabled: hasProject },
    { id: 'project.close', label: 'Close Project', run: () => closeProject(focusedProject()), enabled: hasProject },
    { id: 'wm.compileAll', label: 'Compile All Projects', run: () => { for (const p of projects.value) compileAny(p); }, enabled: () => projects.value.length > 0 },
    { id: 'wm.recompileAll', label: 'Recompile All Projects', run: () => { for (const p of projects.value) compileAny(p); }, enabled: () => projects.value.length > 0 },
    { id: 'wm.openAll', label: 'Open Workspace Documents', run: () => { for (const p of projects.value) openPaths(p, projectPaths(p)); }, enabled: () => projects.value.length > 0 },

    { id: 'wm.openDoc', label: 'Open', run: () => {
      const f = focus.doc;
      if (!f) return;
      const d = openTab(f.project, f.name);
      if (d) activeId.value = d.id; else if (f.project) openPath(f.project, f.path ?? f.name, true);
    }, enabled: hasDoc },
    { id: 'wm.hideDoc', label: 'Hide', run: () => { const d = focusedDoc(); if (d) hideDocs([d]); }, enabled: () => !!focusedDoc() },
    { id: 'wm.closeDoc', label: 'Close', run: () => { const d = focusedDoc(); if (d) cmdClose(d); }, enabled: () => !!focusedDoc() },
    { id: 'wm.saveDoc', label: 'Save', run: () => cmdSave(focusedDoc() ?? null), enabled: () => !!focusedDoc() },
    { id: 'wm.saveDocAs', label: 'Save As...', run: () => cmdSave(focusedDoc() ?? null, true), enabled: () => !!focusedDoc() },
    { id: 'wm.openCategory', label: 'Open All', run: () => { const c = focus.category; if (c) openPaths(c.project, c.paths); }, enabled: () => !!focus.category },
    { id: 'wm.hideCategory', label: 'Hide All', run: () => { const c = focus.category; if (c) hideDocs(tabsOf(c.project, c.paths)); }, enabled: () => !!focus.category },
    { id: 'wm.closeCategory', label: 'Close All', run: () => { const c = focus.category; if (c) closeTabs(tabsOf(c.project, c.paths)); }, enabled: () => !!focus.category },
    { id: 'wm.saveCategory', label: 'Save All', run: () => { const c = focus.category; if (c) return saveTabs(tabsOf(c.project, c.paths)); }, enabled: () => !!focus.category },
    { id: 'window.hideCurrent', label: 'Hide Current', run: () => { const d = focusedDoc(); if (d) hideDocs([d]); }, enabled: () => !!focusedDoc() },
    { id: 'window.hideAll', label: 'Hide All Documents', run: () => hideDocs(visibleDocs()), enabled: () => visibleDocs().length > 0 },

    { id: 'msg.crossProbe', label: 'Cross Probe', run: () => selMessage()?.locate?.(), enabled: () => !!selMessage()?.locate },
    { id: 'msg.next', label: 'Cross Probe Next Message', run: () => stepMessage(1), enabled: () => messages.value.length > 0 },
    { id: 'msg.prev', label: 'Cross Probe Previous Message', run: () => stepMessage(-1), enabled: () => messages.value.length > 0 },
    { id: 'msg.clearAll', label: 'Clear All', run: () => { messages.value = []; msgSel.value = null; }, enabled: () => messages.value.length > 0 },
    { id: 'msg.clearSelected', label: 'Clear Selected', run: () => { messages.value = messages.value.filter((m) => m.no !== msgSel.value); msgSel.value = null; }, enabled: () => !!selMessage() },
    { id: 'msg.clearClass', label: 'Clear Class', run: () => { const m = selMessage(); if (m) { messages.value = messages.value.filter((x) => msgClass(x) !== msgClass(m)); msgSel.value = null; } }, enabled: () => !!selMessage() },
    { id: 'msg.save', label: 'Save...', run: () => saveMessages(messages.value), enabled: () => messages.value.length > 0 },
    { id: 'msg.saveSelected', label: 'Save Selection...', run: () => { const m = selMessage(); return saveMessages(m ? [m] : []); }, enabled: () => !!selMessage() },
    ...(([['None', 'none'], ['Class', 'class'], ['Document', 'document'], ['Source', 'source']] as const).map(([label, g]): Command => ({
      id: `ad:WorkspaceManager:Messages_GroupBy${label}`, label, run: () => { msgGroup.value = g; msgFolded.value = new Set(); }, checked: () => msgGroup.value === g,
    }))),
    { id: 'ad:WorkspaceManager:Messages_MoreInfo', label: 'More Info', run: () => { const m = selMessage(); if (m) showDialog(MessageInfoDialog, { m }); }, enabled: () => !!selMessage() },
    { id: 'ad:WorkspaceManager:Messages_ExportToReport', label: 'Export To Report...', run: async () => {
      if (!messages.value.length) { notify('No messages to export'); return; }
      const h = await saveFileAs('Messages Report.html', new TextEncoder().encode(messagesReportHtml(messages.value, msgGroup.value)));
      if (h !== null) notify('Messages report saved');
    }, enabled: () => messages.value.length > 0 },
    { id: 'ad:WorkspaceManager:Messages_Print', label: 'Print...', run: () => printHtml(messagesReportHtml(messages.value, msgGroup.value)), enabled: () => messages.value.length > 0 },
    { id: 'msg.copy', label: 'Copy', run: async () => {
      const m = selMessage();
      if (!m) return;
      try { await navigator.clipboard.writeText(msgText(m)); notify('Message copied'); } catch { notify('The browser refused clipboard access', 'error'); }
    }, enabled: () => !!selMessage() },
  ];
}
