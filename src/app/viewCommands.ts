/**
 * View and navigation commands behind Altium's single keys: L (Board Layers & Colors),
 * Ctrl+D (View Options), Ctrl+M (Measure Distance), the arrow keys and Enter (keyboard
 * cursor), Shift+PgUp / PgDn and Ctrl+PgUp (zoom), Ctrl+Home / Ctrl+End (jump to the origins),
 * Shift+* (previous signal layer) and 1 / 2 / 3 (Board Planning, 2D and 3D layout modes).
 */
import { showRegionsMode } from './panels/PcbPanel';
import { boardRegions } from '../model/rigidFlex';
import type { Command, Scope } from '../core/commands';
import { active, notify, units } from './state';
import { showDialog } from './dialogs';
import { ViewConfigDialog } from './dialogs/ViewConfig';
import { LayerStackDialog } from './dialogs/LayerStack';
import { InfoDialog } from './dialogs/Confirm';
import { CamEditor } from '../editors/cam/CamEditor';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { hexToRgb, settings } from '../core/settings';
import { PcbLibEditor } from '../editors/pcb/PcbLibEditor';
import { SchEditor } from '../editors/sch/SchEditor';
import { MeasureTool } from '../editors/MeasureTool';
import { UNITS_PER_INCH } from '../core/units';

const ed = () => active.value?.editor ?? null;
const pcb = () => { const e = ed(); return e instanceof PcbEditor ? e : null; };
const board = () => { const e = pcb(); return e && !(e instanceof PcbLibEditor) ? e : null; };
const docEditor = () => { const e = ed(); return e instanceof PcbEditor || e instanceof SchEditor || e instanceof CamEditor ? e : null; };
const PCB: Scope[] = ['pcb'];
const DOCS: Scope[] = ['sch', 'pcb', 'cam'];

/** The keyboard cursor acts where the document has the focus (Enter on a focused button stays the button's). */
const viewFocused = () => {
  const d = docEditor()?.viewport?.host.ownerDocument ?? document;
  const a = d.activeElement;
  return !!docEditor()?.viewport && (!a || a === d.body || !!a.closest?.('.viewport, .centre'));
};

export function viewCommands(): Command[] {
  const cursor = ([...([['Left', -1, 0], ['Right', 1, 0], ['Up', 0, 1], ['Down', 0, -1]] as const)]).flatMap(([dir, dx, dy]): Command[] => [1, 10].map((n) => ({
    id: `cursor.${dir.toLowerCase()}${n === 10 ? '10' : ''}`, label: `Move Cursor ${dir}${n === 10 ? ' 10' : ''}`, scopes: DOCS,
    run: () => { const e = docEditor(); const g = e?.gridSize() ?? 0; e?.viewport?.moveCursorBy(dx * g * n, dy * g * n); },
    enabled: viewFocused,
  })));
  return [
    // Design › Layer Stack Manager: the board's stack, edited and written back as one undo step
    { id: 'pcb.layerStackManager', label: 'Layer Stack Manager...', scopes: PCB, enabled: () => !!pcb()?.doc.board.bag && !(pcb() instanceof PcbLibEditor),
      run: () => { const e = pcb(); if (e) showDialog(LayerStackDialog, { ed: e }); } },
    { id: 'pcb.viewConfigurations', label: 'Board Layers & Colours...', scopes: PCB, run: () => { const e = pcb(); if (e) showDialog(ViewConfigDialog, { ed: e, tab: 'layers' as const }); }, enabled: () => !!pcb() },
    { id: 'pcb.viewOptions', label: 'View Configurations...', scopes: PCB, run: () => { const e = pcb(); if (e) showDialog(ViewConfigDialog, { ed: e, tab: 'options' as const }); }, enabled: () => !!pcb() },
    { id: 'reports.measure', label: 'Measure Distance', scopes: DOCS, run: () => {
      const e = docEditor();
      // On a board, in System Colours' First and Second Dimension Line [est: what AD draws in them]
      const colours = e instanceof PcbEditor ? () => ({ first: hexToRgb(settings.pcbDimLine1), second: hexToRgb(settings.pcbDimLine2) }) : undefined;
      if (e) e.setTool(new MeasureTool(e, () => units.value, (title, lines) => showDialog(InfoDialog, { title, lines }), undefined, colours));
    }, enabled: () => !!docEditor() },
    ...cursor,
    { id: 'cursor.click', label: 'Click', scopes: DOCS, run: () => docEditor()?.viewport?.clickAtCursor(), enabled: viewFocused },
    { id: 'view.zoomInSmall', label: 'Small Zoom In', scopes: DOCS, run: () => docEditor()?.viewport?.zoomBy(1.05), enabled: () => !!docEditor() },
    { id: 'view.zoomOutSmall', label: 'Small Zoom Out', scopes: DOCS, run: () => docEditor()?.viewport?.zoomBy(1 / 1.05), enabled: () => !!docEditor() },
    // 100% is actual size on a 96 dpi screen, as the schematic zoom levels
    { id: 'view.zoom400pcb', label: 'Zoom to 400%', scopes: PCB, run: () => { const e = pcb(); if (e) { e.pushView(); e.viewport?.zoomTo((4 * 96) / UNITS_PER_INCH); } }, enabled: () => !!pcb() },
    { id: 'jump.currentOrigin', label: 'Current Origin', scopes: PCB, run: () => { const e = pcb(); e?.viewport?.cursorTo(e.origin(), true); }, enabled: () => !!pcb() },
    { id: 'pcb.prevSignal', label: 'Previous Signal Layer', scopes: PCB, run: () => pcb()?.prevSignalLayer(), enabled: () => !!pcb() },
    { id: 'view.mode2d', label: '2D Layout Mode', scopes: PCB, run: () => { const e = pcb(); if (!e) return; e.set3d(false); e.setPlanning(false); }, checked: () => !!pcb() && !pcb()!.mode3d && !pcb()!.planning, enabled: () => !!pcb() },
    { id: 'view.mode3d', label: '3D Layout Mode', scopes: PCB, run: () => {
      const e = pcb();
      if (!e) return;
      e.set3d(true);
      if (e.view3d?.failed) notify('3D Layout Mode needs WebGL 2, which this browser has turned off', 'error');
    }, checked: () => !!pcb()?.mode3d, enabled: () => !!pcb() },
    ...([['view3d.top', 'Look Down', '0', 'top'], ['view3d.top90', 'Look Down, Turned 90°', '9', 'top90'], ['view3d.angle', 'Orthogonal View', '8', 'angle']] as const).map(([id, label, , kind]): Command => ({
      id, label, scopes: PCB, run: () => pcb()?.view3d?.view(kind), enabled: () => !!pcb()?.view3d,
    })),
    { id: 'view.modePlanning', label: 'Board Planning Mode', scopes: ['pcb'], run: () => { board()?.setPlanning(true); showRegionsMode(); }, checked: () => !!board()?.planning, enabled: () => !!board() },
    // Rigid-flex: the board folded about its bending lines (in 3D), and back
    { id: 'ad:PCB:FoldUnfold', label: 'Fold/Unfold', scopes: ['pcb'], run: () => {
      const e = board();
      if (!e) return;
      if (!e.mode3d) e.set3d(true);
      e.toggleFold();
    }, checked: () => !!board()?.folded, enabled: () => !!board() && boardRegions(board()!.doc).some((r) => r.bends.length > 0) },
  ];
}
