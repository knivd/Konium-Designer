import { computed, effect, signal } from '@preact/signals';
import type { LoadedDoc } from '../formats/registry';
import type { Editor } from '../editors/Editor';
import type { PrjPcb } from '../formats/altium/prjpcb';
import type { PickedFile } from '../platform/fs';
import type { RecentDocument, RecentProject } from '../platform/recent';
import type { DisplayUnit } from '../core/units';
import type { ChainState } from '../core/keymap';
import type { Scope } from '../core/commands';
import type { Diagnostic } from '../model/common';
import { noteError } from './diagnostics';
import { settings } from '../core/settings';
import { kindShown, setScopeSource, showPanel } from './dock/store';

export interface OpenDoc {
  id: string;
  name: string;
  doc: LoadedDoc;
  editor: Editor | null;
  handle?: FileSystemFileHandle;
  projectId?: string;
  /** Path relative to the project folder, when known. */
  path?: string;
  /** Original bytes, for the inspector. */
  bytes: Uint8Array;
  /** Hidden: open (edits and undo kept) but without a tab, as Altium's Hide. */
  hidden?: boolean;
  /** Open only for a compare (an earlier version): not listed anywhere, closed with the compare. */
  forCompare?: boolean;
  /** Undoes what the tab subscribed to (settings), when it closes. */
  dispose?: () => void;
  /** Save As › Save as type: binary or ASCII (else as it was opened). */
  format?: 'binary' | 'ascii';
}

export interface Project {
  id: string;
  name: string;
  prj: PrjPcb;
  handle?: FileSystemFileHandle;
  /** Files that arrived with the project, keyed by lower-case basename. */
  files: Map<string, PickedFile>;
  /** Name of the folder the project was opened from. */
  folder?: string;
  /** The folder itself, when opened through the File System Access API (outputs are written there). */
  dir?: FileSystemDirectoryHandle;
  /** Path of the .PrjPcb inside `dir` ('/'-separated). */
  path?: string;
  /** The .PrjPcb changed (documents, Project Options) and isn't saved. */
  dirty?: boolean;
}

/** A project's file changed: the Projects panel marks it, Save Project / Save All write it. */
export function markProjectDirty(p: Project): void {
  p.dirty = true;
  projects.value = [...projects.value];
}

/** A row in the Messages panel (Class, Document, Source, Message, Time, Date, No.). */
export interface Message extends Diagnostic {
  doc: string;
  at: number;
  source: string;
  no: number;
  /** Altium's Class column when it isn't the level, e.g. "[Clearance Constraint Violation]". */
  cls?: string;
  /** Double-click in Messages jumps here. */
  locate?: () => void;
}

export const docs = signal<OpenDoc[]>([]);
export const projects = signal<Project[]>([]);
export const activeId = signal<string | null>(null);
export const active = computed(() => docs.value.find((d) => d.id === activeId.value) ?? null);
/**
 * The focused project, as AD's Projects panel has it: new documents go into it. It follows the
 * active document (a free document focuses none), a project just opened or created, and
 * Make Active Project.
 */
export const currentProjectId = signal<string | null>(null);
effect(() => { const d = active.value; if (d) currentProjectId.value = d.projectId ?? null; });
/** The Design Workspace the projects make up: Workspace1.DsnWrk until one is opened or saved. */
export const workspace = signal<{ name: string; handle?: FileSystemFileHandle }>({ name: 'Workspace1.DsnWrk' });
export const currentProject = (): Project | null => projects.value.find((p) => p.id === currentProjectId.value) ?? null;
export const units = signal<DisplayUnit>(settings.defaultUnits);
/**
 * Each open document keeps its own unit, as in AD: a board starts in its Board Options unit
 * (Board6 DISPLAYUNIT: 0 metric, 1 imperial), and Q (Toggle Units) changes the active document's.
 */
const docUnits = new Map<string, DisplayUnit>();
let unitsFor: string | null = null;
effect(() => {
  const d = active.value;
  const id = d?.id ?? null;
  if (id === unitsFor) return;
  unitsFor = id;
  if (!d) return;
  const bag = d.doc.kind === 'PcbDoc' ? d.doc.board.bag : undefined;
  const own = docUnits.get(d.id) ?? (bag?.has('DISPLAYUNIT') ? (bag.int('DISPLAYUNIT') === 0 ? 'mm' : 'mil') : undefined);
  if (own && own !== units.peek()) units.value = own;
});
effect(() => { const u = units.value; const id = activeId.peek(); if (id) docUnits.set(id, u); });
export const messages = signal<Message[]>([]);
export const chain = signal<(ChainState & { at: { x: number; y: number } }) | null>(null);
export const toast = signal<{ text: string; kind: 'ok' | 'error' } | null>(null);
/** Path box in the menu bar row (Altium's navigation bar). */
export const navPath = computed(() => docPath(docs.value.find((x) => x.id === activeId.value)));
/** A document's path from its project's folder (the menu bar's path box). */
export function docPath(d: OpenDoc | null | undefined): string {
  if (!d) return '';
  const p = projects.value.find((x) => x.id === d.projectId);
  const root = p ? (p.folder ?? p.name.replace(/\.prjpcb$/i, '')) : '';
  const rel = (d.path ?? d.name).replace(/\//g, '\\');
  return root ? `${root}\\${rel}` : rel;
}
export const showShortcuts = signal(false);
/** Window › Tile: the open documents side by side ('grid', stacked rows 'h', columns 'v'); null = one at a time. */
export const tileMode = signal<'grid' | 'h' | 'v' | null>(null);
export const showPrefs = signal(false);
/** The Preferences page to open on (DXP › Customize opens Keyboard Shortcuts). */
export const prefsPage = signal<string | null>(null);
/** A project file whose documents need folder access (File › Open Project, drop, OS launch). */
export const projectAccess = signal<{ name: string; handle?: FileSystemFileHandle; file: PickedFile; missing: number; error?: string } | null>(null);
export const recentProjects = signal<RecentProject[]>([]);
export const recentDocuments = signal<RecentDocument[]>([]);

/** View › Home: the Home page, a tab of its own ahead of the documents (its id in activeId). */
export const HOME = 'home';
export const homeOpen = signal(false);
export function openHome(): void { homeOpen.value = true; activeId.value = HOME; }
export function closeHome(): void {
  homeOpen.value = false;
  if (activeId.value === HOME) activeId.value = docs.value.filter((d) => !d.hidden).at(-1)?.id ?? null;
}
/** Help › User Guide and Help › Scripting Reference: a help book in a tab of its own after Home (its id in activeId); `at` the section to show. */
export const HELP = 'help';
export type HelpBook = 'guide' | 'scripting';
export const helpOpen = signal<{ topic: HelpBook; at?: string; n: number } | null>(null);
/** Each request for help has its own number, also after the help was closed: the page tells a new request from its tab coming back in front. */
let helpAsked = 0;
export function openHelp(topic: HelpBook, at?: string): void {
  helpOpen.value = { topic, at, n: ++helpAsked };
  activeId.value = HELP;
}
export function closeHelp(): void {
  helpOpen.value = null;
  if (activeId.value === HELP) activeId.value = docs.value.filter((d) => !d.hidden).at(-1)?.id ?? (homeOpen.value ? HOME : null);
}
/** Bumped whenever the active editor reports a change (selection, cursor, edits). */
export const tick = signal(0);
/** Bumped when an editor's cursor moves (the status bar's coordinates); kept apart from tick so the window doesn't re-render. */
export const cursorTick = signal(0);
/** Last pointer position in the window, for placing accelerator popups. */
export const mouse = { x: 200, y: 200 };

/** A document's menus and keys: its editor's, else by its kind. */
export function scopeOf(d: OpenDoc | null | undefined): Scope {
  if (!d) return 'global';
  // Simulation results open in SimView, netlists and model files in the Mixed Sim text editor
  return d.editor?.scope ?? (d.doc.kind === 'SimData' ? 'simview' : d.doc.kind === 'SimText' ? 'simtext' : 'inspect');
}
export const activeScope = computed<Scope>(() => scopeOf(active.value));
setScopeSource(() => activeScope.value);
// System › View › Remember window for each document kind
effect(() => { kindShown(activeScope.value); });


let toastTimer = 0;
export function notify(text: string, kind: 'ok' | 'error' = 'ok', /** How long it stays, ms (a long note that is to be read through). */ hold?: number): void {
  toast.value = { text, kind };
  if (kind === 'error') noteError(text);
  clearTimeout(toastTimer);
  toastTimer = globalThis.setTimeout(() => { toast.value = null; }, hold ?? (kind === 'error' ? 6000 : 2400)) as unknown as number;
}

let msgNo = 0;
export function log(doc: string, items: (Diagnostic & { locate?: () => void })[], source = 'Konium'): void {
  if (!items.length) return;
  messages.value = [...messages.value, ...items.map((d) => ({ ...d, doc, source, at: Date.now(), no: ++msgNo }))];
  if (settings.autoShowMessages && items.some((d) => d.level !== 'info')) showPanel('messages');
}

/** Replace every message from one source (a fresh compile replaces the last one's results). */
export function replaceMessages(source: string, rows: { doc: string; level: Diagnostic['level']; message: string; cls?: string; locate?: () => void }[]): void {
  const kept = messages.value.filter((m) => m.source !== source);
  const at = Date.now();
  messages.value = [...kept, ...rows.map((r) => ({ ...r, source, at, no: ++msgNo }))];
}

/** Unsaved: an editor's undo history moved on, or an Output Job was changed. */
/** Documents without an editor that keep their own changed flag. */
export const FLAGGED_KINDS = new Set(['OutJob', 'BomDoc', 'DbLink', 'DbLib', 'StepDoc', 'SimText', 'SimData', 'CamDoc', 'Draftsman', 'MbsDoc', 'MbaDoc', 'Diagram', 'Enclosure', 'ReqDoc']);
export const isDocDirty = (d: OpenDoc | undefined | null): boolean => !!d && (!!d.editor?.undo.dirty || (FLAGGED_KINDS.has(d.doc.kind) && !!(d.doc as { dirty?: boolean }).dirty));

/** Keys for a document without an editor (the 3D model editor's Delete, Ctrl+Z…): by document id; true when taken. */
export const docKeys = new Map<string, (combo: string) => boolean>();
