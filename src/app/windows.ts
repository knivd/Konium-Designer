/**
 * Konium's windows, as AD17's Window and File menus have them: Open In New Window (the document
 * moves to a document window of its own: docWindows), Arrange All Windows Horizontally /
 * Vertically (the windows this one opened, across the screen), View › Command Status and
 * File › Exit (unsaved documents offered for saving first; the browser decides whether a tab
 * may close itself).
 */
import type { Command } from '../core/commands';
import { commands } from '../core/commands';
import { settings, updateSettings } from '../core/settings';
import { cmdSave, cmdSaveProject } from './actions';
import { showDialog } from './dialogs';
import { ExitDialog, type Unsaved } from './dialogs/Workspace42';
import { active, docs, isDocDirty, notify, projects, type OpenDoc } from './state';
import { allWindows, docsIn, openDocWindow, placeOf } from './docWindows';
import type { Editor } from '../editors/Editor';
import { focusedOpenDoc } from './workspace';

/** Set while File › Exit closes the window, so the browser's "leave the page?" question isn't asked again. */
export const quitting = { value: false };

/**
 * Window › Open In New Window (a tab's right-click), or a tab dragged out of the window: the
 * document moves to a window of its own, run by this one (docWindows): one project, one undo,
 * cross selection between them as within one window.
 */
export function openInNewWindow(od: OpenDoc | null = active.value): void {
  if (!od) return;
  const w = placeOf(od.id);
  if (w && docsIn(w).length < 2) { notify(`${od.name} is in a window of its own already: drag its tab onto the main window to bring it back`); return; }
  if (openDocWindow(od)) notify(`${od.name} moved to a new window: drag its tab back, or close the window, to bring it back`);
}

/** Window › Arrange All Windows: this window and the ones it opened side by side ('v') or one above another ('h'). */
function arrange(dir: 'h' | 'v'): void {
  const wins = allWindows();
  if (wins.length < 2) { notify('Only one Konium Designer window is open: Open In New Window (a document tab\'s right-click) makes another'); return; }
  const s = screen as Screen & { availLeft?: number; availTop?: number };
  const x0 = s.availLeft ?? 0, y0 = s.availTop ?? 0, n = wins.length;
  let moved = 0;
  wins.forEach((w, i) => {
    try {
      if (dir === 'v') { w.moveTo(Math.round(x0 + (i * s.availWidth) / n), y0); w.resizeTo(Math.round(s.availWidth / n), s.availHeight); }
      else { w.moveTo(x0, Math.round(y0 + (i * s.availHeight) / n)); w.resizeTo(s.availWidth, Math.round(s.availHeight / n)); }
      moved++;
    } catch { /* a window the browser won't move */ }
  });
  notify(`${moved} window${moved === 1 ? '' : 's'} arranged${moved < n ? ' (the browser keeps a tab in its place: installed Konium Designer can be moved)' : ''}`);
}

/** File › Exit: unsaved work first, then the window closes (where the browser lets a page close itself). */
function exit(): void {
  const items: Unsaved[] = [
    ...docs.value.filter(isDocDirty).map((d) => ({ label: d.name, doc: d })),
    ...projects.value.filter((p) => p.dirty).map((p) => ({ label: p.name, project: p })),
  ];
  const quit = async (saveList: Unsaved[]) => {
    for (const u of saveList) { if (u.doc) await cmdSave(u.doc); else if (u.project) await cmdSaveProject(u.project); }
    // A save that failed or was cancelled keeps Konium open
    const left = saveList.filter((u) => (u.doc ? isDocDirty(u.doc) : !!u.project?.dirty));
    if (left.length) { notify(`Konium Designer stays open: ${left.map((u) => u.label).join(', ')} not saved`, 'error'); return; }
    quitting.value = true;
    window.close();
    setTimeout(() => { if (!window.closed) { quitting.value = false; notify('The browser keeps this tab open: close it from the browser (an installed Konium Designer closes itself)'); } }, 400);
  };
  if (items.length) showDialog(ExitDialog, { items, onExit: (s: Unsaved[]) => void quit(s) });
  else void quit([]);
}

/** What View › Command Status shows: the command whose tool is working, else AD's idle text. */
export function commandStatus(ed: Editor | null | undefined): string {
  const id = ed?.tool.id;
  if (!ed || !id || /^select/.test(id)) return 'Idle state - ready for command';
  const label = commands.last?.label.replace(/&/g, '').replace(/\.\.\.$/, '');
  return label || id.replace(/[-.]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export function windowCommands(): Command[] {
  return [
    { id: 'window.openInNewWindow', label: 'Open In New Window', run: () => openInNewWindow(focusedOpenDoc() ?? active.value), enabled: () => !!(focusedOpenDoc() ?? active.value) },
    { id: 'ad:Client:ArrangeAllWindowsHorizontally', label: 'Arrange All Windows Horizontally', run: () => arrange('h') },
    { id: 'ad:Client:ArrangeAllWindowsVertically', label: 'Arrange All Windows Vertically', run: () => arrange('v') },
    { id: 'ad:Client:ToggleCommandStatusBar', label: 'Command Status', run: () => updateSettings({ commandStatus: !settings.commandStatus }), checked: () => settings.commandStatus },
    { id: 'ad:Client:QuitFromEDAClient', label: 'Exit', run: exit },
  ];
}
