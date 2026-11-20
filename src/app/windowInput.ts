/**
 * Keys, right-clicks, the pointer and dropped files, the same in every Konium window (the main one
 * and each document window): shortcuts go to the active document, a right-click opens the
 * desktop software's menu for what is under the cursor, files dropped anywhere open.
 */
import { sketchKey } from './liveSim';
import { normaliseKey } from '../core/keymap';
import { router, shortcutFor } from './commands';
import { openMenuAt } from './MenuBar';
import { menuForElement } from './contextMenus';
import { openBatch, openDropped, unpacked } from './actions';
import { filesFromDrop, handlesFromDrop } from '../platform/fs';
import { active, activeScope, docKeys, mouse, projectAccess } from './state';
import { showDialog } from './dialogs';
import { ToolPropsDialog, hasToolProps } from './panels/Panels';
import { InteractiveRoutingDialog, chooseWidthAt } from './dialogs/RoutingDialog';
import { tabWhilePlacing } from './dialogs/pcbDefaultsDialogs';
import type { RouteTool } from '../editors/pcb/RouteTool';
import type { BusRouteTool } from '../editors/pcb/BusRouteTool';
import type { LengthTuneTool } from '../editors/pcb/LengthTuneTool';
import { BusRoutingDialog, LengthTuningDialog } from './dialogs/RouteTools';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { allWindows, uiWin } from './docWindows';

/**
 * Keys go to a field being typed in (not to check boxes, buttons or sliders, which leave Ctrl+Z
 * and friends to the editor). By tag, not by class: a document window's elements are its own.
 */
export const TYPING = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  if (!el || el.nodeType !== 1) return false;
  return !!el.isContentEditable || /^(TEXTAREA|SELECT)$/.test(el.tagName)
    || (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|range|color)$/.test((el as HTMLInputElement).type));
};

/** Listen in a window; returns what stops listening. */
export function bindWindowInput(win: Window): () => void {
  const doc = win.document;
  // Right-click anywhere: the desktop software's menu for what is under the cursor, never the browser's
  // (text fields keep theirs for Cut / Copy / Paste; the canvas and component menus handle their own)
  const onContext = (e: MouseEvent) => {
    if (e.defaultPrevented) return;
    const t = e.target as HTMLElement;
    if (TYPING(t)) return;
    e.preventDefault();
    if (t.closest?.('.viewport, .menu-popup, .dlg')) return;
    const node = menuForElement(t, activeScope.value);
    if (node?.children?.length) openMenuAt(node, e.clientX + 1, e.clientY + 1);
  };
  const onKey = (e: KeyboardEvent) => {
    uiWin.value = win;
    // A key pressed before the popup selection dialog shows: it doesn't
    const pe = active.value?.editor;
    if (pe instanceof PcbEditor) pe.cancelChoice();
    // A modal dialog owns the keyboard. Esc reaches it even when focus wandered outside.
    // The top dialog: the last opened (each sits in a backdrop of its own)
    const open = doc.querySelectorAll<HTMLElement>('.dlg');
    const dlg = open[open.length - 1];
    if (dlg) {
      if (!dlg.contains(e.target as Node) && e.key === 'Escape') { e.preventDefault(); dlg.querySelector<HTMLElement>('.dlg-x')?.click(); }
      if ((e.ctrlKey || e.metaKey) && /^[spo]$/i.test(e.key)) e.preventDefault();
      return;
    }
    // A dialog open in another window: the documents take no keys meanwhile
    if (allWindows().some((w) => w !== win && !!w.document.querySelector('.dlg'))) return;
    if (TYPING(e.target)) return;
    const combo = normaliseKey(e);
    if (projectAccess.value) { if (combo === 'Escape') { projectAccess.value = null; e.preventDefault(); } return; }
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(combo)) return;
    const own = active.value ? docKeys.get(active.value.id) : undefined;
    if (own?.(combo)) { e.preventDefault(); return; }
    const ed = active.value?.editor ?? null;
    const toolKey = (c: string) => {
      if (!ed) return false;
      // Tab while placing on a board: the object's AD17 dialog on what goes down next; while routing, Interactive Routing
      if (c === 'Tab' && ed instanceof PcbEditor) {
        if (ed.tool.id === 'route') { showDialog(InteractiveRoutingDialog, { ed }); return true; }
        if (ed.tool.id === 'route-diffpair' || ed.tool.id === 'route-multi') { showDialog(BusRoutingDialog, { ed, tool: ed.tool as unknown as BusRouteTool }); return true; }
        if (ed.tool.id === 'tune' || ed.tool.id === 'tune-pair') {
          const t = ed.tool as unknown as LengthTuneTool;
          showDialog(LengthTuningDialog, { ed, net: t.net, onDone: () => { t.refresh(); ed.invalidateOverlay(); } });
          return true;
        }
        if (tabWhilePlacing(ed, ed.tool.id)) return true;
      }
      // Shift+W while routing: the favourite widths at the cursor
      if (c === 'Shift+W' && ed instanceof PcbEditor && ed.tool.id === 'route') { chooseWidthAt(ed.tool as unknown as RouteTool, ed, mouse.x, mouse.y); return true; }
      if (c === 'Tab' && hasToolProps(ed.tool.id)) { showDialog(ToolPropsDialog, { toolId: ed.tool.id }); return true; }
      return ed.toolKey(c);
    };
    // A sheet running in Live Simulation: a single key places a part of its palette (where that is switched on)
    if (sketchKey(combo)) { e.preventDefault(); e.stopPropagation(); return; }
    if (router.handle(combo, activeScope.value, toolKey)) { e.preventDefault(); e.stopPropagation(); }
    else if (/^Ctrl\+[SOPDM]$/.test(combo)) e.preventDefault(); // keep the browser's own dialogs out of the way
  };
  // F1 in a field being typed in: no field has a use for it, so the guide opens for the panel the field is in. In the
  // bubbling phase: a field with an F1 of its own (the Scripts panel's code) has taken it by then. Not under a dialog.
  const onHelpKey = (e: KeyboardEvent) => {
    if (e.key !== 'F1' || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || !TYPING(e.target)) return;
    if (allWindows().some((w) => !!w.document.querySelector('.dlg')) || projectAccess.value || shortcutFor('help.guide') !== 'F1') return;
    if (router.handle('F1', activeScope.value, () => false)) e.preventDefault();
  };
  const onMove = (e: MouseEvent) => { mouse.x = e.clientX; mouse.y = e.clientY; };
  const onOver = (e: DragEvent) => { e.preventDefault(); };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    // Read both views synchronously: the DataTransfer empties once the handler awaits
    const handles = handlesFromDrop(e), plain = filesFromDrop(e);
    void (async () => { const hs = await handles; if (hs.length) await openDropped(hs, () => plain); else openBatch(await unpacked(await plain)); })();
  };
  const onPress = () => { uiWin.value = win; };
  win.addEventListener('pointerdown', onPress, true);
  win.addEventListener('keydown', onKey, true);
  win.addEventListener('keydown', onHelpKey);
  win.addEventListener('contextmenu', onContext);
  win.addEventListener('mousemove', onMove, { passive: true });
  win.addEventListener('dragover', onOver);
  win.addEventListener('drop', onDrop);
  return () => {
    win.removeEventListener('pointerdown', onPress, true);
    win.removeEventListener('keydown', onKey, true);
    win.removeEventListener('keydown', onHelpKey);
    win.removeEventListener('contextmenu', onContext);
    win.removeEventListener('mousemove', onMove);
    win.removeEventListener('dragover', onOver);
    win.removeEventListener('drop', onDrop);
  };
}
