import { ImportWizardDialog } from './dialogs/ImportWizard';
import { ExportWizardDialog } from './dialogs/ExportWizard';
import { commands, type Command, type Scope } from '../core/commands';
import type { Vec2 } from '../core/geom';
import { KeyRouter, type AccelNode, type MenuRoot, type Shortcut } from '../core/keymap';
import { SchEditor } from '../editors/sch/SchEditor';
import { PcbEditor } from '../editors/pcb/PcbEditor';
import { pasteForeign } from './pcbForeignPaste';
import { allowLocalFonts } from './boardOpened';
import { chooseBackupFolder, chooseTemplate, clearBackupFolder } from './dataManagement';
import { PcbLibEditor } from '../editors/pcb/PcbLibEditor';
import { FootprintDialog } from './panels/PcbLibraryPanel';
import { footprintsFromBoard } from '../model/pcbLib';
import { writePcbLib } from '../formats/altium/pcblib';
import { addNewDocument, freshName, openDocument, cmdClose, cmdNewDocument, cmdNewPcb, cmdNewPcbLib, cmdNewSchLib, cmdOpen, cmdOpenDemo, cmdOpenSimDemo, cmdOpenProject, cmdSave, cmdSaveAll, cmdSaveAsTyped, cmdSaveCopyAs, cycleTab, openSelectionProperties, reopenRecent, reopenRecentDocument } from './actions';
import { outputCommands } from './outputCommands';
import { dimensionCommands } from './dimensionCommands';
import { buildMenus, contextMenuFor, plannedCommands, registerMenuProvider, systemMenu, ad17Shortcuts } from './menus';
import { cmdAnnotateQuietly, cmdForceAnnotate, cmdResetDesignators } from './annotation';
import { RotateByDialog } from './dialogs/RotateBy';
import { AboutDialog } from './dialogs/About';
import { NewProjectDialog } from './dialogs/NewProject';
import { cmdUpdateSchematics } from './differences';
import { ZoomAreaTool } from '../editors/Editor';
import type { AlignKind } from '../editors/align';
import { activeProject } from './project';
import { OFF_BY_DEFAULT, toolbarShown, toolbarsFor } from './Toolbar';
import { newDocTarget, workspaceCommands, visibleDocs } from './workspace';
import { workspaceFileCommands } from './workspaceFiles';
import { windowCommands } from './windows';
import { dbLinkCommands } from './dbLink';
import { dbLibCommands } from './dbLibActions';
import { textTarget } from './textTarget';
import { simCommands } from './simCommands';
import { camCommands } from './camCommands';
import { camEditCommands } from './camEditCommands';
import { camPlaceCommands } from './camPlaceCommands';
import { camViewCommands } from './camViewCommands';
import { camToolCommands } from './camToolCommands';
import { camFileCommands } from './camFileCommands';
import { placeCommands } from './placeCommands';
import { projectCommands } from './projectCommands';
import { harnessCommands } from './harnessCommands';
import { FEATURES, FEATURE_COMMANDS, featureOn } from '../core/release';
import { harnessKind } from '../model/harness';
import type { SchDocument } from '../model/sch';
import { schMiscCommands } from './schMiscCommands';
import { syncCommands } from './syncCommands';
import { viewCommands } from './viewCommands';
import { schlibCommands } from './schlibCommands';
import { schCommands } from './schCommands';
import { hierarchyCommands } from './hierarchy';
import { NET_COLOURS, schEditCommands } from './schEditCommands';
import { memoryItems } from './selectionMemory';
import { libSyncCommands } from './libSync';
import { libToolCommands } from './libTools';
import { libEditCommands } from './libEditCommands';
import { pcbEditCommands } from './pcbEditCommands';
import { pcbNetCommands } from './pcbNetCommands';
import { pcbComponentCommands } from './pcbComponentCommands';
import { layerSetItems, pcbOptionsCommands } from './pcbOptionsCommands';
import { pcbClassCommands } from './pcbClassCommands';
import { pcbQueryCommands } from './pcbQueryCommands';
import { pcbRouteCommands } from './pcbRouteCommands';
import { pcbRoomCommands } from './pcbRoomCommands';
import { pcbUnionCommands } from './pcbUnionCommands';
import { pcbGridCommands } from './pcbGridCommands';
import { pcbAutoCommands } from './pcbAutoCommands';
import { aiCommands } from './aiCommands';
import { pcb3dCommands } from './pcb3dCommands';
import { pcb41Commands } from './pcb41Commands';
import { editCommands, jumpLocationMark, locationMarks, setLocationMark } from './editCommands';
import { mil, mm } from '../core/units';
import { settings, updateSettings } from '../core/settings';
import { cmdCompile } from './project';
import { compileAny, compileCaption } from './libPkg';
import { showDialog } from './dialogs';
import { AnnotateDialog } from './dialogs/Annotate';
import { RulesDialog } from './dialogs/Rules';
import { DrcDialog } from './dialogs/Drc';
import { cmdUpdatePcb } from './eco';
import { DrillSetupDialog, GerberSetupDialog, PickPlaceSetupDialog } from './dialogs/Outputs';
import { Ipc2581Dialog, OdbSetupDialog, StepExportDialog } from './dialogs/FabOutputs';
import { clipboard } from '../editors/clipboard';
import { AreaSelectTool, PickTool, ToggleSelectTool } from '../editors/Editor';
import { MoveByDialog } from './dialogs/MoveBy';
import { PolygonManagerDialog } from './dialogs/PolygonManager';
import { FindSimilarDialog } from './dialogs/FindSimilar';
import { PolygonDialog, newPolygonBag } from './dialogs/Polygon';
import type { PropertyBag } from '../formats/altium/props';
import { L, isSignal, layerName } from '../model/layers';
import { currentProject, isDocDirty, active, activeId, activeScope, docs, notify, openHome, prefsPage, projects, recentDocuments, recentProjects, showPrefs, showShortcuts, tick, units } from './state';
import { newStepDoc } from '../model/stepDoc';
import { SupportDialog } from './dialogs/Support';
import { ReportBugDialog } from './dialogs/ReportBug';
import { ContactDialog } from './dialogs/Contact';
import { GetKoniumDialog } from './dialogs/GetKonium';
import { layout, layoutJson, loadLayoutJson, panelOpen, restoreLayout, togglePanel, toggleFloating } from './dock/store';
import { switchFloatingFocus } from './dock/Dock';
import { pickTextFile, saveFileAs } from '../platform/fs';
import { PANELS, panelAvailable, panelTitle, type PanelCategory } from './dock/panels';
import { vcsCommands } from './vcsCommands';

const ALIGN_LABELS: Record<AlignKind, string> = {
  left: 'Align Left', right: 'Align Right', top: 'Align Top', bottom: 'Align Bottom', hCentre: 'Align Horizontal Centres', vCentre: 'Align Vertical Centres',
  distributeH: 'Distribute Horizontally', distributeV: 'Distribute Vertically',
};
/** Snap Grid popup values (Altium's list): command id → size. */
const GRID_COMMANDS: [string, number][] = [
  ['grid.set:1mil', mil(1)], ['grid.set:5mil', mil(5)], ['grid.set:10mil', mil(10)], ['grid.set:20mil', mil(20)], ['grid.set:25mil', mil(25)],
  ['grid.set:50mil', mil(50)], ['grid.set:100mil', mil(100)], ['grid.set:0.025mm', mm(0.025)], ['grid.set:0.1mm', mm(0.1)], ['grid.set:0.25mm', mm(0.25)],
  ['grid.set:0.5mm', mm(0.5)], ['grid.set:1mm', mm(1)], ['grid.set:2.5mm', mm(2.5)],
];

/** View › Workspace Panels: command id → panel. */
export const PANEL_COMMANDS: Record<string, string> = {
  'view.panel.projects': 'projects', 'view.panel.navigator': 'navigator', 'view.panel.inspector': 'fileInspector', 'view.panel.library': 'library',
  'view.panel.properties': 'inspector', 'view.panel.messages': 'messages', 'view.panel.filter': 'filter', 'view.panel.list': 'list',
  'view.panel.libraries': 'libraries', 'view.panel.pcb': 'pcb', 'view.panel.rules': 'rules', 'view.panel.activeRoute': 'activeRoute', 'view.panel.simdata': 'simdata', 'view.panel.cam': 'cam', 'view.panel.storage': 'storage',
};
const panelCommand = (id: string, panel: string, label: string): Command => ({
  id, label, run: () => togglePanel(panel, activeScope.value), checked: () => panelOpen(panel),
  enabled: () => panelAvailable(panel, activeScope.value) || panel === 'library',
});

const ed = () => active.value?.editor ?? null;
const sch = () => { const e = ed(); return e instanceof SchEditor ? e : null; };
const pcb = () => { const e = ed(); return e instanceof PcbEditor ? e : null; };
const hasEd = () => !!ed();
/** Preferences › Schematic › Clipboard Reference: Copy / Cut on a sheet first asks for the point to paste by. */
function withClipRef(go: (at: Vec2 | null) => void): void {
  const e = sch();
  if (!e || e.libraryMode || !settings.schClipboardReference) { go(null); return; }
  e.setTool(new PickTool(e, 'Choose the clipboard reference point', (p) => { go(e.snap(p.raw)); return true; }));
}
const clip = () => ed() as unknown as { copy?(): boolean; cut?(): void; paste?(stamp?: boolean): void; duplicate?(): void } | null;
const plib = () => { const e = ed(); return e instanceof PcbLibEditor ? e : null; };
const board = () => { const e = pcb(); return e && !(e instanceof PcbLibEditor) ? e : null; };

/** Design › Make PCB Library: the board's footprints into <board>.PcbLib (a free name if taken). */
function makePcbLibrary(): void {
  const e = board();
  if (!e) return;
  const defs = footprintsFromBoard(e.doc);
  if (!defs.length) { notify('The board has no components to take footprints from', 'error'); return; }
  const base = e.doc.name.replace(/\.pcbdoc$/i, '');
  const taken = new Set([...docs.value.map((d) => d.name.toLowerCase()), ...projects.value.flatMap((p) => [...p.files.keys()])]);
  let name = `${base}.PcbLib`;
  for (let i = 1; taken.has(name.toLowerCase()); i++) name = `${base}${i}.PcbLib`;
  addNewDocument(name, writePcbLib(defs), currentProject());
  notify(`${name}: ${defs.length} footprint${defs.length > 1 ? 's' : ''} from ${e.doc.name}`);
}

// A command that fails says so (in the status line and the console) instead of failing silently
commands.onError = (c, e) => { console.error(c.id, e); notify(`${c.label.replace(/[&.]/g, '')}: ${(e as Error)?.message ?? e}`, 'error'); };
if (typeof window !== 'undefined') window.addEventListener('unhandledrejection', (e) => {
  const err = e.reason as DOMException | Error | undefined;
  if (err && (err.name === 'AbortError')) return; // a file selector cancelled
  notify(`Something went wrong: ${err?.message ?? String(e.reason)}`, 'error');
});

commands.register(
  // File
  { id: 'file.open', label: 'Open...', run: cmdOpen },
  { id: 'file.openProject', label: 'Open Project...', run: cmdOpenProject },
  { id: 'file.importWizard', label: 'Import Wizard', run: () => showDialog(ImportWizardDialog, { files: [] }) },
  { id: 'file.exportWizard', label: 'Export Wizard', run: () => showDialog(ExportWizardDialog, { type: undefined }) },
  { id: 'file.exportKicad', label: 'KiCad Project', run: () => showDialog(ExportWizardDialog, { type: 'kicad' }) },
  { id: 'file.exportPads', label: 'PADS ASCII Design Files', run: () => showDialog(ExportWizardDialog, { type: 'pads' }) },
  { id: 'file.exportEasyeda', label: 'EasyEDA Source Files', run: () => showDialog(ExportWizardDialog, { type: 'easyeda' }) },
  { id: 'file.exportEasyedaPro', label: 'EasyEDA Pro Project', run: () => showDialog(ExportWizardDialog, { type: 'easyedapro' }) },
  { id: 'file.exportCadence', label: 'OrCAD and Allegro (ASCII Files)', run: () => showDialog(ExportWizardDialog, { type: 'cadence' }) },
  { id: 'file.exportEagle', label: 'EAGLE Design Files', run: () => showDialog(ExportWizardDialog, { type: 'eagle' }) },
  { id: 'file.exportDiptrace', label: 'DipTrace XML Files', run: () => showDialog(ExportWizardDialog, { type: 'diptrace' }) },
  { id: 'file.exportSpecctra', label: 'Specctra Design (Autorouter)', run: () => showDialog(ExportWizardDialog, { type: 'specctra' }) },
  { id: 'file.exportEdif', label: 'EDIF Schematic', run: () => showDialog(ExportWizardDialog, { type: 'edif' }) },
  ...Array.from({ length: 9 }, (_, i): Command => ({
    id: `file.recent.${i + 1}`, label: `Recent project ${i + 1}`,
    run: () => { const r = recentProjects.value[i]; if (r) void reopenRecent(r); },
    enabled: () => !!recentProjects.value[i],
  })),
  ...Array.from({ length: 9 }, (_, i): Command => ({
    id: `file.recentDoc.${i + 1}`, label: `Recent document ${i + 1}`,
    run: () => { const r = recentDocuments.value[i]; if (r) void reopenRecentDocument(r); },
    enabled: () => !!recentDocuments.value[i],
  })),
  { id: 'file.openDemo', label: 'Open Demo Project', run: cmdOpenDemo },
  { id: 'file.openSimDemo', label: 'Open Simulation Demo', run: cmdOpenSimDemo },
  // Konium's own: a new 3D model (STEP) in the 3D model editor
  { id: 'file.newStepModel', label: '3D Model (STEP)', run: () => {
    const name = freshName('Model', 'step');
    const od = openDocument({ name, bytes: new Uint8Array(0) });
    if (od) { od.doc = newStepDoc(name); tick.value++; }
  } },
  // View › Home; the tip jar and Download beside the menus
  { id: 'view.home', label: 'Home', run: openHome },
  { id: 'help.support', label: 'Support Konium Designer...', run: () => showDialog(SupportDialog) },
  { id: 'help.reportBug', label: 'Report a Bug...', run: () => showDialog(ReportBugDialog) },
  { id: 'help.contact', label: 'Contact the Author...', run: () => showDialog(ContactDialog, { topic: undefined }) },
  { id: 'help.whatsNew', label: 'What\'s New', run: () => { openHome(); setTimeout(() => document.getElementById('whats-new')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120); } },
  // Always there: a tab installs, a downloaded file is pointed to konium.app, the installed app says so
  { id: 'help.getKonium', label: 'Get Konium Designer on This Computer...', run: () => showDialog(GetKoniumDialog) },
  { id: 'file.save', label: 'Save', run: () => cmdSave(active.value), enabled: () => !!active.value },
  { id: 'file.saveAs', label: 'Save As...', run: () => cmdSaveAsTyped(active.value), enabled: () => !!active.value },
  { id: 'file.saveAll', label: 'Save All', run: () => cmdSaveAll(), enabled: () => docs.value.some(isDocDirty) || projects.value.some((p) => !!p.dirty) },
  { id: 'file.close', label: 'Close', run: () => cmdClose(active.value), enabled: () => !!active.value },
  { id: 'file.newSch', label: 'Schematic', run: () => cmdNewDocument('SchDoc', newDocTarget()) },
  { id: 'file.newPcb', label: 'PCB', run: () => cmdNewPcb(newDocTarget()) },
  { id: 'file.newProject', label: 'Project...', run: () => showDialog(NewProjectDialog) },
  { id: 'file.newSchLib', label: 'Schematic Library', run: () => cmdNewSchLib(newDocTarget()) },
  { id: 'file.newPcbLib', label: 'PCB Library', run: () => cmdNewPcbLib(newDocTarget()) },

  // Edit
  { id: 'edit.undo', label: 'Undo', run: () => { const t = textTarget(); if (t) { t.undo(); return; } const l = ed()?.undo.undo(); if (l) notify(`Undid ${l.toLowerCase()}`); }, enabled: () => !!textTarget() || !!ed()?.undo.canUndo },
  { id: 'edit.redo', label: 'Redo', run: () => { const t = textTarget(); if (t) { t.redo(); return; } const l = ed()?.undo.redo(); if (l) notify(`Redid ${l.toLowerCase()}`); }, enabled: () => !!textTarget() || !!ed()?.undo.canRedo },
  { id: 'edit.delete', label: 'Delete', run: () => ed()?.deleteSelection(), enabled: () => !!ed()?.selection.size },
  { id: 'edit.selectAll', label: 'All', run: () => { const t = textTarget(); if (t) t.selectAll(); else ed()?.selectAll(); }, enabled: () => !!textTarget() || hasEd() },
  { id: 'edit.deselectAll', label: 'All On Current Document', run: () => { ed()?.clearSelection(); pcb()?.clearHighlight(); }, enabled: hasEd },
  { id: 'edit.move', label: 'Move', scopes: ['sch', 'pcb'], run: () => { sch()?.startMove('move'); pcb()?.startMove('move'); }, enabled: hasEd },
  { id: 'edit.drag', label: 'Drag', scopes: ['sch', 'pcb'], run: () => { sch()?.startMove('drag'); pcb()?.startMove('drag'); }, enabled: () => !!sch() || !!pcb() },
  { id: 'edit.moveSelection', label: 'Move Selection', scopes: ['sch', 'pcb'], run: () => { sch()?.startMove('move', true); pcb()?.startMove('move', true); }, enabled: () => !!ed()?.selection.size },
  { id: 'edit.dragSelection', label: 'Drag Selection', scopes: ['sch', 'pcb'], run: () => { sch()?.startMove('drag', true); pcb()?.startMove('drag', true); }, enabled: () => !!ed()?.selection.size },
  { id: 'edit.moveSelectionXY', label: 'Move Selection by X, Y...', scopes: ['sch', 'pcb'], run: () => {
    const e = ed() as unknown as { moveBy?(d: { x: number; y: number }): void } | null;
    if (e?.moveBy) showDialog(MoveByDialog, { units: sch() ? 'mil' : units.value, onOk: (d: { x: number; y: number }) => e.moveBy!(d) });
  }, enabled: () => !!ed()?.selection.size },
  { id: 'edit.rotateSelection', label: 'Rotate Selection', scopes: ['sch', 'pcb'], run: () => { sch()?.rotateSelection(1); pcb()?.rotateSelection(1); }, enabled: () => !!ed()?.selection.size && ed()?.tool.id === 'select' },
  { id: 'edit.rotateSelectionCw', label: 'Rotate Selection Clockwise', scopes: ['sch', 'pcb'], run: () => { sch()?.rotateSelection(3); pcb()?.rotateSelection(-1); }, enabled: () => !!ed()?.selection.size && ed()?.tool.id === 'select' },
  { id: 'pcb.polygonVertices', label: 'Polygon Vertices', scopes: ['pcb'], run: () => {
    const e = pcb();
    if (!e) return;
    e.setTool(new PickTool(e, 'Polygon Vertices: click the polygon pour to edit', (p) => {
      const k = e.hits(p.raw).map((h) => h.key).find((x) => x.startsWith('poly:'));
      if (!k) return false;
      e.select([k]);
      notify('Drag a vertex handle to move it, a mid-edge handle to add a vertex; drop a vertex on its neighbour to remove it');
      return true;
    }));
  }, enabled: () => !!pcb()?.doc.polygons.length },

  // Edit › Select
  { id: 'select.insideArea', label: 'Inside Area', scopes: ['sch', 'pcb'], run: () => { const e = ed(); e?.setTool(new AreaSelectTool(e, 'inside')); }, enabled: () => !!sch() || !!pcb() },
  { id: 'select.outsideArea', label: 'Outside Area', scopes: ['sch', 'pcb'], run: () => { const e = ed(); e?.setTool(new AreaSelectTool(e, 'outside')); }, enabled: () => !!sch() || !!pcb() },
  { id: 'select.touchingRect', label: 'Touching Rectangle', scopes: ['sch', 'pcb'], run: () => { const e = ed(); e?.setTool(new AreaSelectTool(e, 'touchingRect')); }, enabled: () => !!sch() || !!pcb() },
  { id: 'select.touchingLine', label: 'Touching Line', scopes: ['sch', 'pcb'], run: () => { const e = ed(); e?.setTool(new AreaSelectTool(e, 'touchingLine')); }, enabled: () => !!sch() || !!pcb() },
  { id: 'select.toggle', label: 'Toggle Selection', scopes: ['sch', 'pcb'], run: () => { const e = ed(); const p = pcb(); e?.setTool(new ToggleSelectTool(e, p ? (k) => p.keysFor(k) : undefined)); }, enabled: () => !!sch() || !!pcb() },
  { id: 'select.allOnLayer', label: 'All on Layer', scopes: ['pcb'], run: () => pcb()?.selectAllOnLayer(), enabled: () => !!pcb() },
  { id: 'select.freeObjects', label: 'Free Objects', scopes: ['pcb'], run: () => pcb()?.selectWhere((p) => !('component' in p) || p.component === 0xffff), enabled: () => !!pcb() },
  { id: 'select.allLocked', label: 'All Locked', scopes: ['pcb'], run: () => pcb()?.selectWhere((p) => 'locked' in p && p.locked), enabled: () => !!pcb() },
  { id: 'select.net', label: 'Net', scopes: ['pcb'], run: () => {
    const e = pcb();
    e?.setTool(new PickTool(e, 'Select Net: click an object of the net (Shift adds); right-click to finish', (p) => {
      const h = e.hits(p.raw).find((x) => x.net !== undefined && x.net !== 0xffff);
      if (h) e.selectNet(h.net!, p.shift);
      return false;
    }, true));
  }, enabled: () => !!pcb() },
  { id: 'select.connectedCopper', label: 'Connected Copper', scopes: ['pcb'], run: () => {
    const e = pcb();
    if (!e) return;
    // Ctrl+H acts on the copper under the cursor at once; from the menu, click it
    if (!e.selectConnectedCopper(e.cursor)) e.setTool(new PickTool(e, 'Select Connected Copper: click copper', (p) => e.selectConnectedCopper(p.raw, p.shift)));
  }, enabled: () => !!pcb() },

  ...([['Left', -1, 0], ['Right', 1, 0], ['Up', 0, 1], ['Down', 0, -1]] as const).flatMap(([dir, dx, dy]): Command[] => [
    { id: `edit.nudge${dir}`, label: `Move Selection ${dir}`, scopes: ['sch', 'pcb'], run: () => { const e = ed() as unknown as { nudge?(x: number, y: number): void }; e?.nudge?.(dx, dy); }, enabled: () => !!ed()?.selection.size },
    { id: `edit.nudge${dir}10`, label: `Move Selection ${dir} ×10`, scopes: ['sch', 'pcb'], run: () => { const e = ed() as unknown as { nudge?(x: number, y: number): void }; e?.nudge?.(dx * 10, dy * 10); }, enabled: () => !!ed()?.selection.size },
  ]),
  { id: 'edit.cut', label: 'Cut', run: () => { const t = textTarget(); if (t) { t.cut(); return; } withClipRef((at) => { const e = sch(); if (e && at) { if (e.copy(at)) e.deleteSelection(); } else clip()?.cut?.(); }); }, enabled: () => !!textTarget() || (!!ed()?.selection.size && !!clip()?.cut) },
  { id: 'edit.copy', label: 'Copy', run: () => { const t = textTarget(); if (t) { t.copy(); return; } withClipRef((at) => { const e = sch(); if (e && at ? e.copy(at) : clip()?.copy?.()) notify('Copied'); }); }, enabled: () => !!textTarget() || (!!ed()?.selection.size && !!clip()?.copy) },
  // On a board with nothing copied in Konium: what another application copied (Preferences › PCB Editor › General › Paste from other applications)
  { id: 'edit.paste', label: 'Paste', run: () => { const t = textTarget(); if (t) { t.paste(); return; } const b = pcb(); if (b && clipboard?.kind !== 'pcb') { void pasteForeign(b); return; } clip()?.paste?.(); },
    enabled: () => !!textTarget() || (!!clipboard && clipboard.kind === family(ed()?.scope) && !!clip()?.paste) || (!!pcb() && clipboard?.kind !== 'pcb') },
  { id: 'edit.rubberStamp', label: 'Rubber Stamp', run: () => clip()?.paste?.(true), enabled: () => !!clipboard && clipboard.kind === family(ed()?.scope) && !!clip()?.paste },
  { id: 'edit.duplicate', label: 'Duplicate', run: () => clip()?.duplicate?.(), enabled: () => !!ed()?.selection.size && !!clip()?.duplicate },

  // View
  { id: 'view.fit', label: 'Fit Document', run: () => ed()?.fit(), enabled: hasEd },
  { id: 'view.fitSelection', label: 'Selected Objects', run: () => ed()?.fitSelection(), enabled: () => !!ed()?.selection.size },
  { id: 'view.zoomIn', label: 'Zoom In', run: () => ed()?.viewport?.zoomStep(true), enabled: hasEd },
  { id: 'view.zoomOut', label: 'Zoom Out', run: () => ed()?.viewport?.zoomStep(false), enabled: hasEd },
  { id: 'view.centre', label: 'Pan', run: () => ed()?.viewport?.centreOnCursor(), enabled: hasEd },
  { id: 'view.redraw', label: 'Refresh', run: () => ed()?.invalidate(), enabled: hasEd },
  { id: 'view.units', label: 'Toggle Units', run: () => { units.value = units.value === 'mil' ? 'mm' : 'mil'; ed()?.invalidateOverlay(); } },
  { id: 'view.grid', label: 'Cycle Snap Grid', run: () => ed()?.cycleGrid(), enabled: hasEd },
  { id: 'view.flip', label: 'Flip Board', scopes: ['pcb'], run: () => {
    const e = pcb();
    if (e?.view3d) { e.view3d.flip(); return; }
    if (e?.viewport) { e.viewport.cam.flipX = !e.viewport.cam.flipX; e.invalidate(); }
  }, checked: () => { const e = pcb(); return e?.view3d ? e.view3d.fromBelow : !!e?.viewport?.cam.flipX; } },
  panelCommand('view.panel.projects', 'projects', 'Projects'),
  panelCommand('view.panel.navigator', 'navigator', 'Navigator'),
  panelCommand('view.panel.inspector', 'fileInspector', 'File Inspector'),
  panelCommand('view.panel.library', 'library', 'Library Panel'),
  panelCommand('view.panel.properties', 'inspector', 'Object Inspector'),
  panelCommand('view.panel.filter', 'filter', 'Filter Editor'),
  panelCommand('view.panel.pcb', 'pcb', 'PCB'),
  panelCommand('view.panel.rules', 'rules', 'PCB Rules And Violations'),
  panelCommand('view.panel.activeRoute', 'activeRoute', 'PCB ActiveRoute'),
  // F12 / Shift+F12 on a board or footprint: PCB Filter and PCB List
  panelCommand('ad:PCB:PCBExpressionFilter', 'filter', 'Filter Editor'),
  panelCommand('ad:PCB:PCBLibExpressionFilter', 'filter', 'Filter Editor'),
  panelCommand('ad:PCB:PCBObjectList', 'list', 'Object List'),
  panelCommand('view.panel.list', 'list', 'Object List'),
  panelCommand('view.panel.messages', 'messages', 'Messages'),
  panelCommand('view.panel.libraries', 'libraries', 'Libraries'),
  panelCommand('view.panel.simdata', 'simdata', 'Sim Data'),
  panelCommand('view.panel.cam', 'cam', 'CAM'),
  panelCommand('view.panel.storage', 'storage', 'Storage Manager'),
  { id: 'view.togglePanels', label: 'Toggle Floating Panels Visibility', run: () => toggleFloating(), checked: () => !layout.value.floatHidden },
  { id: 'view.switchPanelFocus', label: 'Toggle Floating Panels Focus', run: () => switchFloatingFocus() },
  { id: 'view.layout.default', label: 'Default', run: () => restoreLayout('default') },
  { id: 'view.layout.startup', label: 'Startup', run: () => restoreLayout('startup') },
  { id: 'view.layout.save', label: 'Save Layout...', run: () => { void saveFileAs('Konium.KoniumLayout', new TextEncoder().encode(layoutJson())); } },
  { id: 'view.layout.load', label: 'Load Layout...', run: () => { void (async () => {
    const f = await pickTextFile('.KoniumLayout,.json,application/json');
    if (!f) return;
    try { loadLayoutJson(f.text); notify(`Desktop layout loaded from ${f.name}`); } catch (e) { notify(`Couldn't load ${f.name}: ${(e as Error).message}`, 'error'); }
  })(); } },
  { id: 'view.toolbars', label: 'Toolbars', run: () => updateSettings({ toolbars: !settings.toolbars }), checked: () => settings.toolbars },

  // Place
  { id: 'place.wire', label: 'Wire', scopes: ['sch'], run: () => sch()?.startWire() },
  { id: 'place.bus', label: 'Bus', scopes: ['sch'], run: () => sch()?.startWire(true) },
  { id: 'place.track', label: 'Track', scopes: ['pcb'], run: () => pcb()?.startTrack() },
  { id: 'place.pad', label: 'Pad', scopes: ['pcb'], run: () => pcb()?.startPad() },
  { id: 'place.polygon', label: 'Polygon Pour...', scopes: ['pcb'], run: () => {
    const e = board();
    if (!e) return;
    // The net under the cursor, else the highlighted net, as Altium pre-fills Connect to Net
    const net = e.hits(e.cursor).find((h) => h.net !== undefined && h.net !== 0xffff)?.net ?? e.highlightNet ?? 0xffff;
    const layer = isSignal(e.currentLayer) ? e.currentLayer : L.TOP;
    showDialog(PolygonDialog, { doc: e.doc, units: units.value, bag: newPolygonBag(e.doc, layer, net), onOk: (b: PropertyBag) => e.startPlacePolygon(b) });
  }, enabled: () => !!board() },

  // PCB layers
  { id: 'pcb.nextSignal', label: 'Next Signal Layer', scopes: ['pcb'], run: () => pcb()?.nextSignalLayer() },
  { id: 'pcb.layerUp', label: 'Next Layer', scopes: ['pcb'], run: () => pcb()?.stepLayer(1) },
  { id: 'pcb.layerDown', label: 'Previous Layer', scopes: ['pcb'], run: () => pcb()?.stepLayer(-1) },
  { id: 'pcb.singleLayer', label: 'Single Layer Mode', scopes: ['pcb'], run: () => { const e = pcb(); if (e) { e.cycleSingleLayer(); notify(e.mode3d ? (e.singleLayer === 'off' ? 'Single layer mode: off' : `Single layer mode: ${layerName(e.currentLayer)} alone`) : `Single layer mode: ${e.singleLayer}`); } } },
  // Board Insight: the heads-up display (Shift+H) and its delta origin (Insert)
  { id: 'dm.chooseTemplate', label: 'Choose Template...', run: () => { void chooseTemplate(); } },
  { id: 'dm.chooseBackupFolder', label: 'Choose Backup Folder...', run: () => { void chooseBackupFolder(); } },
  { id: 'dm.clearBackupFolder', label: 'No Backup Folder', run: () => { void clearBackupFolder(); } },
  { id: 'pcb.allowLocalFonts', label: 'Allow Reading Fonts', run: () => { void allowLocalFonts().then((ok) => notify(ok ? 'Konium Designer may read this computer\'s fonts: boards can embed them' : 'The browser didn\'t allow reading this computer\'s fonts (Chrome and Edge on a computer can)', ok ? 'ok' : 'error')); } },
  { id: 'pcb.headsUp', label: 'Toggle Heads Up Display', scopes: ['pcb', 'pcblib'], run: () => { updateSettings({ pcbHud: !settings.pcbHud }); notify(`Heads-up display ${settings.pcbHud ? 'on' : 'off'}`); } },
  { id: 'pcb.headsUpReset', label: 'Reset Heads Up Delta Origin', scopes: ['pcb', 'pcblib'], enabled: () => settings.pcbHud && settings.pcbHudInsertResets, run: () => pcb()?.resetHudDelta() },
  { id: 'pcb.clearHighlight', label: 'Clear Filter', scopes: ['sch', 'pcb', 'schlib', 'pcblib'], run: () => { pcb()?.clearHighlight(); pcb()?.setMask(null); sch()?.setMask(null); }, enabled: () => !!pcb() || !!sch() },

  // Design / Tools / Route / Reports
  { id: 'design.updatePcb', label: 'Update PCB Document', scopes: ['sch'], run: cmdUpdatePcb },
  { id: 'design.importChanges', label: 'Import Changes From Project', scopes: ['pcb'], run: cmdUpdatePcb },
  { id: 'design.updateSch', label: 'Update Schematics', scopes: ['pcb'], run: cmdUpdateSchematics, enabled: () => !!activeProject() },
  { id: 'design.rules', label: 'Rules...', scopes: ['pcb'], run: () => { const e = pcb(); if (e) showDialog(RulesDialog, { ed: e }); }, enabled: () => !!pcb() },
  { id: 'tools.annotate', label: 'Annotate Schematics...', scopes: ['sch'], run: () => showDialog(AnnotateDialog) },
  { id: 'tools.newFootprint', label: 'New Blank Footprint', scopes: ['pcb'], run: () => plib()?.newFootprint(), enabled: () => !!plib() },
  { id: 'tools.removeFootprint', label: 'Remove Footprint', scopes: ['pcb'], run: () => plib()?.deleteFootprint(), enabled: () => (plib()?.lib.footprints.length ?? 0) > 1 },
  { id: 'tools.footprintProperties', label: 'Footprint Properties...', scopes: ['pcb'], run: () => { const l = plib(); if (l) showDialog(FootprintDialog, { ed: l, index: l.current }); }, enabled: () => !!plib() },
  { id: 'design.makePcbLib', label: 'Make PCB Library', scopes: ['pcb'], run: makePcbLibrary, enabled: () => !!board() },
  { id: 'tools.drc', label: 'Design Rule Check...', scopes: ['pcb'], run: () => { const e = pcb(); if (e) showDialog(DrcDialog, { ed: e }); }, enabled: () => !!pcb() },
  { id: 'tools.resetMarkers', label: 'Reset Error Markers', scopes: ['pcb'], run: () => pcb()?.resetErrorMarkers(), enabled: () => !!pcb()?.violations.length },
  { id: 'tools.erc', label: 'Compile PCB Project', scopes: ['sch', 'pcb'], run: () => { const p = activeProject(); if (p) compileAny(p); else cmdCompile(); } },
  { id: 'tools.repour', label: 'Repour All', scopes: ['pcb'], run: () => { const e = pcb(); if (e) { e.repourPolygons(); notify(`Repoured ${e.doc.polygons.length} polygon${e.doc.polygons.length === 1 ? '' : 's'}`); } }, enabled: () => !!pcb()?.doc.polygons.length },
  { id: 'tools.polygonManager', label: 'Polygon Manager...', scopes: ['pcb'], run: () => { const e = board(); if (e) showDialog(PolygonManagerDialog, { ed: e }); }, enabled: () => !!board() },
  { id: 'tools.shelve', label: 'Shelve Polygons', scopes: ['pcb'], run: () => { const e = pcb(); if (e) e.shelvePolygons(e.selectedPolygons().length ? e.selectedPolygons() : e.doc.polygons.map((p) => p.index), true); }, enabled: () => !!pcb()?.doc.polygons.some((p) => !p.bag.bool('SHELVED')) },
  { id: 'tools.restore', label: 'Restore Shelved Polygons', scopes: ['pcb'], run: () => { const e = pcb(); if (e) e.shelvePolygons(e.doc.polygons.map((p) => p.index), false); }, enabled: () => !!pcb()?.doc.polygons.some((p) => p.bag.bool('SHELVED')) },
  { id: 'tools.repourSelected', label: 'Repour Selected', scopes: ['pcb'], run: () => { const e = pcb(); if (e) e.repourPolygons(e.selectedPolygons()); }, enabled: () => !!pcb()?.selectedPolygons().length },
  { id: 'route.interactive', label: 'Interactive Routing', scopes: ['pcb'], run: () => pcb()?.startRoute() },
  { id: 'pcb.moveComponent', label: 'Component', scopes: ['pcb'], run: () => pcb()?.startMoveComponent() },
  { id: 'output.gerberX2', label: 'Gerber X2 Files', scopes: ['pcb'], run: () => { const e = pcb(); if (e) showDialog(GerberSetupDialog, { ed: e, x2: true }); }, enabled: () => !!pcb() },
  { id: 'output.ipc2581', label: 'IPC-2581 Files', scopes: ['pcb'], run: () => { const e = pcb(); if (e) showDialog(Ipc2581Dialog, { ed: e }); }, enabled: () => !!pcb() },
  { id: 'output.odb', label: 'ODB++ Files', scopes: ['pcb'], run: () => { const e = pcb(); if (e) showDialog(OdbSetupDialog, { ed: e }); }, enabled: () => !!pcb() },
  { id: 'file.exportStep', label: 'STEP 3D', scopes: ['pcb', 'pcblib'], run: () => { const e = active.value?.editor; if (e instanceof PcbEditor) showDialog(StepExportDialog, { ed: e }); }, enabled: () => active.value?.editor instanceof PcbEditor },
  // Konium's own: the same 3D as an STL mesh
  { id: 'file.exportStl', label: 'STL 3D', scopes: ['pcb', 'pcblib'], run: () => { const e = active.value?.editor; if (e instanceof PcbEditor) showDialog(StepExportDialog, { ed: e, format: 'stl' as const }); }, enabled: () => active.value?.editor instanceof PcbEditor },
  { id: 'output.gerber', label: 'Gerber Files', scopes: ['pcb'], run: () => { const e = pcb(); if (e) showDialog(GerberSetupDialog, { ed: e }); }, enabled: () => !!pcb() },
  { id: 'output.drill', label: 'NC Drill Files', scopes: ['pcb'], run: () => { const e = pcb(); if (e) showDialog(DrillSetupDialog, { ed: e }); }, enabled: () => !!pcb() },
  { id: 'output.pnp', label: 'Generates pick and place files', scopes: ['pcb'], run: () => { const e = pcb(); if (e) showDialog(PickPlaceSetupDialog, { ed: e }); }, enabled: () => !!pcb() },

  // Tools, selection, jump
  { id: 'tool.select', label: 'Select', run: () => ed()?.setTool(null), enabled: hasEd },
  { id: 'view.fitObjects', label: 'Fit All Objects', run: () => ed()?.fitObjects(), enabled: hasEd },
  // Ctrl+Home: on a board, Altium's absolute origin (the workspace corner); a sheet's or footprint's origin otherwise
  { id: 'jump.origin', label: 'Origin', run: () => { const e = ed(); if (e?.viewport) e.viewport.cursorTo(board() ? { x: 0, y: 0 } : e.origin(), true); }, enabled: hasEd },
  { id: 'edit.findSimilar', label: 'Find Similar Objects', scopes: ['sch', 'pcb'], run: () => {
    const e = ed();
    if (!e) return;
    // The object under the cursor (right-click menu, Shift+F), else click one
    const under = e.hits(e.cursor)[0]?.key;
    if (under) { showDialog(FindSimilarDialog, { ed: e, key: under }); return; }
    e.setTool(new PickTool(e, 'Find Similar Objects: click an object', (p) => {
      const k = e.hits(p.raw)[0]?.key;
      if (!k) return false;
      showDialog(FindSimilarDialog, { ed: e, key: k });
      return true;
    }));
  }, enabled: () => !!sch() || !!pcb() },
  { id: 'tools.preferences', label: 'Preferences...', run: () => { showPrefs.value = true; } },
  { id: 'ctx.properties', label: 'Properties...', run: () => openSelectionProperties() },

  // Window / Help
  { id: 'window.next', label: 'Next Document', run: () => cycleTab(1) },
  { id: 'window.prev', label: 'Previous Document', run: () => cycleTab(-1) },
  { id: 'window.closeAll', label: 'Close All Documents', run: async () => { for (const d of [...docs.value]) if (!(await cmdClose(d))) break; }, enabled: () => docs.value.length > 0 },
  { id: 'help.shortcuts', label: 'Shortcut Keys', run: () => { showShortcuts.value = !showShortcuts.value; } },
);

/* ─── Altium Designer 17 parity: commands behind AD17's menu items ─────────────────── */

const family = (sc: Scope | undefined): Scope | undefined => (sc === 'pcblib' ? 'pcb' : sc === 'schlib' ? 'sch' : sc);
const selected = () => !!ed()?.selection.size;
const aligner = () => ed() as unknown as { align?(k: AlignKind): void; alignToGrid?(): void } | null;
const hitKeyUnderCursor = () => { const e = ed(); return e ? e.hits(e.cursor)[0]?.key : undefined; };
/** Area tools that take objects out of the selection (Edit › DeSelect). */
function deselectArea(mode: 'inside' | 'outside' | 'touchingRect' | 'touchingLine'): void {
  const e = ed();
  if (!e) return;
  const before = new Set(e.selection);
  e.setTool(new AreaSelectTool(e, mode, (keys) => { e.selection = new Set([...before].filter((k) => !keys.includes(k))); }));
}

commands.register(...placeCommands());
commands.register(...viewCommands());
commands.register(...editCommands());
commands.register(...schlibCommands());
commands.register(...schCommands());
commands.register(...hierarchyCommands());
commands.register(...schEditCommands());
commands.register(...libSyncCommands());
commands.register(...libToolCommands());
commands.register(...libEditCommands());
commands.register(...pcbEditCommands());
commands.register(...pcbNetCommands());
commands.register(...pcbComponentCommands());
commands.register(...projectCommands());
commands.register(...harnessCommands());
commands.register(...schMiscCommands());
commands.register(...syncCommands());
commands.register(...outputCommands());
commands.register(...dimensionCommands());
commands.register(...pcbOptionsCommands());
commands.register(...pcbClassCommands());
commands.register(...pcbQueryCommands());
commands.register(...pcbRouteCommands());
commands.register(...pcbRoomCommands());
commands.register(...pcbUnionCommands());
commands.register(...pcbGridCommands());
commands.register(...pcbAutoCommands());
commands.register(...aiCommands());
commands.register(...pcb3dCommands());
commands.register(...pcb41Commands());
commands.register(...vcsCommands());
commands.register(...workspaceCommands(), ...workspaceFileCommands(), ...windowCommands(), ...dbLinkCommands(), ...dbLibCommands(), ...simCommands(), ...camCommands(), ...camEditCommands(), ...camPlaceCommands(), ...camViewCommands(), ...camToolCommands(), ...camFileCommands());

commands.register(
  { id: 'file.saveCopyAs', label: 'Save Copy As...', run: () => cmdSaveCopyAs(active.value), enabled: () => !!active.value },
  { id: 'edit.deleteTool', label: 'Delete', scopes: ['sch', 'pcb'], run: () => {
    const e = ed();
    if (!e) return;
    // Altium's Edit › Delete: click objects one after another; right-click ends
    e.setTool(new PickTool(e, 'Delete: click the objects to delete; right-click to finish', (p) => {
      const k = e.hits(p.raw)[0]?.key;
      if (!k) return false;
      const pe = pcb();
      e.selection = new Set(pe ? pe.keysFor(k) : [k]);
      e.deleteSelection();
      return false;
    }, true));
  }, enabled: () => !!sch() || !!pcb() },
  { id: 'deselect.insideArea', label: 'Inside Area', scopes: ['sch', 'pcb'], run: () => deselectArea('inside'), enabled: selected },
  { id: 'deselect.outsideArea', label: 'Outside Area', scopes: ['sch', 'pcb'], run: () => deselectArea('outside'), enabled: selected },
  { id: 'deselect.touchingRect', label: 'Touching Rectangle', scopes: ['sch', 'pcb'], run: () => deselectArea('touchingRect'), enabled: selected },
  { id: 'deselect.touchingLine', label: 'Touching Line', scopes: ['sch', 'pcb'], run: () => deselectArea('touchingLine'), enabled: selected },
  { id: 'deselect.allOnLayer', label: 'All on Layer', scopes: ['pcb'], run: () => { const e = pcb(); if (e) { const keys = new Set(e.allItems().filter((i) => i.layer === e.currentLayer).map((i) => i.key)); e.deselectWhere((k) => keys.has(k)); } }, enabled: selected },
  { id: 'deselect.freeObjects', label: 'Free Objects', scopes: ['pcb'], run: () => { const e = pcb(); if (e) e.deselectWhere((k) => { const p = e.primByKey(k); return !!p && (!('component' in p) || p.component === 0xffff); }); }, enabled: selected },
  { id: 'edit.deselectAllDocs', label: 'All Open Documents', run: () => { for (const d of docs.value) d.editor?.clearSelection(); }, enabled: () => docs.value.length > 0 },
  { id: 'select.board', label: 'Board', scopes: ['pcb'], run: () => board()?.selectBoard(), enabled: () => !!board() },
  ...(['left', 'right', 'top', 'bottom', 'hCentre', 'vCentre', 'distributeH', 'distributeV'] as AlignKind[]).map((k): Command => ({
    id: `align.${k}`, label: ALIGN_LABELS[k], scopes: ['sch', 'pcb'], run: () => aligner()?.align?.(k), enabled: () => (ed()?.selection.size ?? 0) > 1,
  })),
  { id: 'align.toGrid', label: 'Align To Grid', scopes: ['sch', 'pcb'], run: () => aligner()?.alignToGrid?.(), enabled: selected },
  { id: 'pcb.rotateSelectionBy', label: 'Rotate Selection...', scopes: ['pcb'], run: () => {
    const e = pcb();
    if (e) showDialog(RotateByDialog, { step: settings.pcbRotationStep || 90, onOk: (deg: number) => e.rotateSelectionBy(deg) });
  }, enabled: selected },
  { id: 'view.area', label: 'Area', scopes: ['sch', 'pcb', 'cam'], run: () => { const e = ed(); if (e) e.setTool(new ZoomAreaTool(e)); }, enabled: () => !!sch() || !!pcb() || active.value?.doc.kind === 'CamDoc' },
  { id: 'view.zoomLast', label: 'Zoom Last', run: () => { if (!ed()?.zoomLast()) notify('No previous view'); }, enabled: hasEd },
  { id: 'view.aroundPoint', label: 'Around Point', scopes: ['sch', 'pcb'], run: () => { const e = ed(); if (e) e.setTool(new PickTool(e, 'Zoom Around Point: click the centre of the new view', (p) => { e.pushView(); e.viewport?.cam.centreOn(p.world); e.viewport?.zoomStep(true); return true; })); }, enabled: () => !!sch() || !!pcb() },
  ...([50, 100, 200, 400] as const).map((z): Command => ({
    id: `view.zoom${z}`, label: `${z}%`, scopes: ['sch'], run: () => { const e = ed(); const c = e?.viewport?.cam; if (e && c) { e.pushView(); c.scale = (z / 100) * 96 / 1_000_000; e.viewport!.requestRender(); e.changed.emit(); } }, enabled: hasEd,
  })),
  { id: 'view.fullScreen', label: 'Full Screen', run: () => { if (document.fullscreenElement) void document.exitFullscreen(); else void document.documentElement.requestFullscreen?.(); }, checked: () => !!document.fullscreenElement },
  { id: 'view.gridReverse', label: 'Cycle Snap Grid (Reverse)', run: () => ed()?.cycleGrid(-1), enabled: hasEd },
  { id: 'view.visibleGrid', label: 'Toggle Visible Grid', run: () => { const e = ed(); if (e) { e.gridVisible = !e.gridVisible; e.invalidate(); } }, enabled: hasEd, checked: () => !!ed()?.gridVisible },
  { id: 'view.fitBoard', label: 'Fit Board', scopes: ['pcb'], run: () => { const e = pcb(); const o = e?.doc.board.outline; if (e && o && o.length >= 3) { e.pushView(); e.viewport?.fitBox({ minX: Math.min(...o.map((v) => v.x)), minY: Math.min(...o.map((v) => v.y)), maxX: Math.max(...o.map((v) => v.x)), maxY: Math.max(...o.map((v) => v.y)) }); } else e?.fitObjects(); }, enabled: () => !!pcb() },
  { id: 'view.statusBar', label: 'Status Bar', run: () => updateSettings({ statusBar: !settings.statusBar }), checked: () => settings.statusBar },
  { id: 'pcb.showAllConnections', label: 'Show All', scopes: ['pcb'], run: () => { updateSettings({ pcbShowConnections: true }); const e = pcb(); e?.hiddenConnections.clear(); e?.invalidate(); } },
  { id: 'pcb.hideAllConnections', label: 'Hide All', scopes: ['pcb'], run: () => { const e = pcb(); if (e) for (const n of e.doc.nets) e.hiddenConnections.add(n.index); e?.invalidate(); } },
  { id: 'tools.shelveSelected', label: 'Shelve Selected', scopes: ['pcb'], run: () => { const e = pcb(); if (e) e.shelvePolygons(e.selectedPolygons(), true); }, enabled: () => !!pcb()?.selectedPolygons().length },
  { id: 'pcb.movePolygon', label: 'Move Polygon', scopes: ['pcb'], run: () => pcb()?.startMove('move', true), enabled: () => !!pcb()?.selectedPolygons().length },
  { id: 'pcb.moveThisComponent', label: 'Move Component', scopes: ['pcb'], run: () => { const e = pcb(); const k = hitKeyUnderCursor(); if (e && k) { e.select(e.keysFor(k)); e.startMove('move', true); } }, enabled: () => !!pcb() },
  { id: 'pcb.toggleDesignator', label: 'Toggle Component Designator', scopes: ['pcb'], run: () => pcb()?.toggleComponentTexts('NAMEON'), enabled: () => !!pcb()?.moveSet().components.length },
  { id: 'pcb.toggleComment', label: 'Toggle Component Comment', scopes: ['pcb'], run: () => pcb()?.toggleComponentTexts('COMMENTON'), enabled: () => !!pcb()?.moveSet().components.length },
  { id: 'plib.next', label: 'Next Component', scopes: ['pcblib'], run: () => { const l = plib(); if (l) l.showFootprint(Math.min(l.current + 1, l.lib.footprints.length - 1)); }, enabled: () => !!plib() && plib()!.current < plib()!.lib.footprints.length - 1 },
  { id: 'plib.prev', label: 'Prev Component', scopes: ['pcblib'], run: () => { const l = plib(); if (l) l.showFootprint(Math.max(l.current - 1, 0)); }, enabled: () => !!plib() && plib()!.current > 0 },
  { id: 'plib.first', label: 'First Component', scopes: ['pcblib'], run: () => plib()?.showFootprint(0), enabled: () => !!plib() },
  { id: 'plib.last', label: 'Last Component', scopes: ['pcblib'], run: () => { const l = plib(); if (l) l.showFootprint(l.lib.footprints.length - 1); }, enabled: () => !!plib() },
  { id: 'dxp.customize', label: 'Customise...', run: () => { prefsPage.value = 'shortcuts'; showPrefs.value = true; } },
  { id: 'help.about', label: 'About...', run: () => showDialog(AboutDialog, { at: undefined }) },
  { id: 'file.new', label: 'New', run: () => router.openChain(fileNewMenu(activeScope.value), activeScope.value) },
  { id: 'tools.resetDesignators', label: 'Reset Schematic Designators...', scopes: ['sch'], run: () => cmdResetDesignators(false), enabled: () => !!sch() },
  { id: 'tools.resetDuplicates', label: 'Reset Duplicate Schematic Designators...', scopes: ['sch'], run: () => cmdResetDesignators(true), enabled: () => !!sch() },
  { id: 'tools.annotateQuietly', label: 'Annotate Schematics Quietly...', scopes: ['sch'], run: cmdAnnotateQuietly, enabled: () => !!sch() },
  { id: 'tools.forceAnnotate', label: 'Force Annotate All Schematics...', scopes: ['sch'], run: cmdForceAnnotate, enabled: () => !!sch() },
  // Snap Grid popup (G on a board): the grids Altium lists
  ...GRID_COMMANDS.map(([id, size]): Command => ({ id, label: id.slice(9), scopes: ['pcb'], run: () => ed()?.setGrid(size), enabled: hasEd, checked: () => ed()?.gridSize() === size })),
  ...plannedCommands((m) => notify(m)),
);

// Features not released yet: shown as planned (greyed, "Planned feature"), saying so when chosen
for (const [id, f] of Object.entries(FEATURE_COMMANDS)) {
  const c = commands.get(id);
  if (!c || featureOn(f)) continue;
  c.planned = true;
  c.run = () => notify(`${FEATURES[f].name} is a planned feature: it comes in a later release`);
}

/** Captions that follow the project and documents, as Altium's do. */
const projectName = () => activeProject()?.name;
const setCaption = (id: string, fn: () => string | undefined) => { const c = commands.get(id); if (c) c.caption = fn; };
setCaption('tools.erc', () => compileCaption(activeProject(), 'C&ompile'));
setCaption('design.updatePcb', () => { const p = activeProject(); const pcbDoc = p?.prj.documents.map((d) => d.split(/[\\/]/).pop()!).find((d) => /\.pcbdoc$/i.test(d)); return pcbDoc ? `&Update PCB Document ${pcbDoc}` : undefined; });
setCaption('design.importChanges', () => { const n = projectName(); return n ? `&Import Changes From ${n}` : undefined; });
setCaption('design.updateSch', () => { const n = projectName(); return n ? `&Update Schematics in ${n}` : undefined; });

/* ─── Menus: Altium Designer 17's, letter for letter (P then W = Place › Wire) ──────── */

const item = (key: string, command: string, label?: string, separatorBefore?: boolean): AccelNode =>
  ({ key, command, label: label ?? commands.get(command)?.label ?? command, separatorBefore });
const placeholder = (label: string): AccelNode => ({ key: '', label, disabled: true });

registerMenuProvider('@recentProjects', () => recentProjects.value.length
  ? recentProjects.value.slice(0, 9).map((r, i) => ({ key: String(i + 1), label: `${i + 1} ${r.name}  (${r.folder})`, accelAt: 0, command: `file.recent.${i + 1}` }))
  : [placeholder('No recent projects')]);
registerMenuProvider('@recentDocuments', () => recentDocuments.value.length
  ? recentDocuments.value.slice(0, 9).map((r, i) => ({ key: String(i + 1), label: `${i + 1} ${r.name}`, accelAt: 0, command: `file.recentDoc.${i + 1}` }))
  : [placeholder('No recent documents')]);
registerMenuProvider('@toolbars', (scope) => toolbarsFor(scope).map((b) => ({
  key: '', label: b.label, checked: toolbarShown(b.id),
  action: () => {
    const flip = (l: string[]) => (l.includes(b.id) ? l.filter((x) => x !== b.id) : [...l, b.id]);
    updateSettings(OFF_BY_DEFAULT.has(b.id) ? { shownToolbars: flip(settings.shownToolbars) } : { hiddenToolbars: flip(settings.hiddenToolbars) });
  },
})));
/** One category of View › Workspace Panels (and its status-bar button): the panels with a tick when open. */
export function panelCategoryItems(cat: PanelCategory, scope: Scope): AccelNode[] {
  const cmd = Object.fromEntries(Object.entries(PANEL_COMMANDS).map(([c, p]) => [p, c]));
  return PANELS.filter((p) => p.category(scope) === cat)
    // A panel with no command of its own (Clipboard, Scripts, Design Adviser, Requirements, Signal Integrity …) toggles directly
    .map((p) => ({ key: p.key, label: panelTitle(p.id, scope), command: cmd[p.id], checked: panelOpen(p.id),
      ...(cmd[p.id] ? {} : { action: () => togglePanel(p.id, scope), disabled: !panelAvailable(p.id, scope) }) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
const PANEL_CATEGORIES: [PanelCategory, string][] = [['Design Compiler', 'D'], ['SCH', 'S'], ['PCB', 'P'], ['Mixed Sim', 'M'], ['CAM', 'C'], ['System', 'Y']];
registerMenuProvider('@panels', (scope) => PANEL_CATEGORIES
  .map(([c, key]): AccelNode => ({ key, label: c, children: panelCategoryItems(c, scope) }))
  .filter((n) => n.children!.length > 0));
registerMenuProvider('@layouts', () => [item('D', 'view.layout.default'), item('S', 'view.layout.startup'), item('L', 'view.layout.load', undefined, true), item('A', 'view.layout.save')]);
registerMenuProvider('@windows', () => visibleDocs().map((d, i) => ({
  key: i < 9 ? String(i + 1) : '', label: `${i + 1} ${d.name}${isDocDirty(d) ? ' *' : ''}`, accelAt: i < 9 ? 0 : undefined,
  checked: d.id === active.value?.id, action: () => { activeId.value = d.id; },
})));
registerMenuProvider('@fabOutputs', () => [
  item('C', 'output.compositeDrill', 'Composite Drill Guide'), item('D', 'output.drillDrawings', 'Drill Drawings'), item('F', 'output.final', 'Final'),
  item('G', 'output.gerber', 'Gerber Files'), item('X', 'output.gerberX2', 'Gerber X2 Files'), item('I', 'output.ipc2581', 'IPC-2581 Files'),
  item('M', 'output.maskSet', 'Mask Set'), item('N', 'output.drill', 'NC Drill Files'), item('O', 'output.odb', 'ODB++ Files'),
  item('P', 'output.powerPlane', 'Power-Plane Set'), item('T', 'output.testPoint', 'Test Point Report'),
]);
registerMenuProvider('@exports', () => [item('S', 'file.exportStep', 'STEP 3D'), item('L', 'file.exportStl', 'STL 3D'), item('K', 'file.exportKicad', 'KiCad Project...'), item('P', 'file.exportPads', 'PADS ASCII...'), item('E', 'file.exportEasyeda', 'EasyEDA...'), item('R', 'file.exportEasyedaPro', 'EasyEDA Pro...'), item('O', 'file.exportCadence', 'OrCAD and Allegro...'), item('G', 'file.exportEagle', 'EAGLE...'), item('T', 'file.exportDiptrace', 'DipTrace...'), item('C', 'file.exportSpecctra', 'Specctra Design...'), item('D', 'file.exportEdif', 'EDIF Schematic...')]);
registerMenuProvider('@assemblyOutputs', () => [item('A', 'output.assemblyDrawings', 'Assembly Drawings'), item('G', 'output.pnp', 'Generates pick and place files'), item('T', 'output.testPoint', 'Test Point Report')]);
const harnessKindOfActive = () => active.value?.doc.kind === 'SchDoc' && !!harnessKind(active.value.doc as SchDocument);
registerMenuProvider('@reports', () => [
  item('I', 'reports.bom', 'Bill of Materials'), item('C', 'reports.crossRef', 'Component Cross Reference'), item('P', 'reports.hierarchy', 'Report Project Hierarchy'),
  item('S', 'reports.simpleBom', 'Simple BOM'), item('N', 'reports.singlePinNets', 'Report Single Pin Nets'),
  ...(harnessKindOfActive() ? [{ ...item('W', 'reports.harnessWires', 'Harness Wire List'), separatorBefore: true }] : []),
]);
registerMenuProvider('@newContext', () => [
  item('S', 'file.newSch', 'Schematic'), item('P', 'file.newPcb', 'PCB'), { ...item('L', 'file.newSchLib', 'Schematic Library'), separatorBefore: true }, item('Y', 'file.newPcbLib', 'PCB Library'),
]);
// Location marks 1–10: Set stores the cursor, Jump goes back to it (marks not set are greyed)
registerMenuProvider('@setLocationMarks', () => Array.from({ length: 10 }, (_, i) => ({ key: String((i + 1) % 10), label: `${i + 1}`, accelAt: 0,
  action: () => { const e = ed(); if (e) setLocationMark(e, i + 1); } })));
registerMenuProvider('@jumpLocationMarks', () => { const e = ed(); const m = e ? locationMarks(e) : new Map(); return Array.from({ length: 10 }, (_, i) => ({ key: String((i + 1) % 10), label: `${i + 1}`, accelAt: 0,
  disabled: !m.has(i + 1), action: () => { const x = ed(); if (x) jumpLocationMark(x, i + 1); } })); });
for (const [name, what] of [['@memoryStore', 'store'], ['@memoryRecall', 'recall'], ['@memoryStorePlus', 'storePlus'], ['@memoryRecallPlus', 'recallPlus'], ['@memoryApply', 'apply'], ['@memoryClear', 'clear']] as const) {
  registerMenuProvider(name, () => memoryItems(ed(), what));
}
registerMenuProvider('@netColours', () => NET_COLOURS.map(([label], i) => item('', `sch.netColour.${i}`, label)));
registerMenuProvider('@layerSets', () => { const l = layerSetItems(); return l.length ? l : [placeholder('No layer sets')]; });

export const MENUS: MenuRoot[] = buildMenus();
// Konium's own: the demo project, under Help
{
  const help = MENUS.filter((m) => m.inMenuBar && m.label === 'Help');
  for (const h of help) {
    const get = Object.getOwnPropertyDescriptor(h, 'children')!.get!;
    Object.defineProperty(h, 'children', { get: () => [...get.call(h), { ...item('D', 'file.openDemo', 'Open Demo Project'), separatorBefore: true }], enumerable: true, configurable: true });
  }
}
// Konium's own: File › New › 3D Model (STEP), after Output Job File
for (const f of MENUS.filter((m) => m.inMenuBar && m.label === 'File')) {
  const get = Object.getOwnPropertyDescriptor(f, 'children')!.get!;
  Object.defineProperty(f, 'children', {
    get: () => (get.call(f) as AccelNode[]).map((c) => {
      if (c.label !== 'New' || !c.children) return c;
      const i = c.children.findIndex((n) => n.command === 'ad:WorkspaceManager:NewJob');
      return { ...c, children: [...c.children.slice(0, i + 1), item('O', 'file.newStepModel', '3D Model (STEP)'), ...c.children.slice(i + 1)] };
    }),
    enumerable: true, configurable: true,
  });
}
// AD17's rigid-flex items (Design: split and bending lines after Move Board Shape; View: Fold/Unfold
// after the layout modes), which the menus here were made without; and later AD's Advanced
// Rigid-Flex (Slice Board Region, Place › Board Region) and coverlay (Place Coverlay Polygon /
// Cutout, Coverlay Actions)
{
  const insertAfter = (label: string, after: string, add: () => AccelNode[]) => {
    for (const m of MENUS.filter((x) => x.inMenuBar && x.label === label && x.scopes.includes('pcb'))) {
      const get = Object.getOwnPropertyDescriptor(m, 'children')!.get!;
      Object.defineProperty(m, 'children', {
        get: () => { const c = get.call(m) as AccelNode[]; const i = c.findIndex((n) => n.command === after); return i < 0 ? c : [...c.slice(0, i + 1), ...add(), ...c.slice(i + 1)]; },
        enumerable: true, configurable: true,
      });
    }
  };
  insertAfter('Design', 'ad:PCB:MoveBoardShape', () => [
    { ...item('S', 'ad:PCB:PlaceSplitLine', 'Define Split Line'), separatorBefore: true }, item('', 'ad:PCB:DeleteSplitLine', 'Delete Split Line'),
    { ...item('E', 'ad:PCB:PlaceBendingLine', 'Define Bending Line'), separatorBefore: true },
    item('', 'ad:PCB:SliceBoardRegion', 'Slice Board Region'),
    { ...item('', 'ad:PCB:PlaceCoverlayPolygon', 'Place Coverlay Polygon'), separatorBefore: true }, item('', 'ad:PCB:PlaceCoverlayCutout', 'Place Coverlay Cutout'),
    { key: '', label: 'Coverlay Actions', children: [item('A', 'ad:PCB:AddCoverlay', 'Add Coverlay'), item('R', 'ad:PCB:RemoveCoverlay', 'Remove Coverlay')] },
  ]);
  insertAfter('Place', 'ad:PCB:CutPolygonPlane', () => [{ ...item('', 'ad:PCB:PlaceBoardRegion', 'Board Region'), separatorBefore: true }]);
  insertAfter('View', 'view.mode3d', () => [item('', 'ad:PCB:FoldUnfold', 'Fold/Unfold')]);
}
export const SYSTEM_MENU = (scope: Scope): AccelNode => systemMenu(scope);

/** File › New, for the toolbar's New button and Ctrl+N. */
export function fileNewMenu(scope: Scope): AccelNode {
  const file = MENUS.find((m) => m.inMenuBar && m.label === 'File' && m.scopes.includes(scope)) ?? MENUS.find((m) => m.inMenuBar && m.label === 'File');
  const nw = file?.children.find((c) => c.label === 'New' && c.children);
  return { key: '', label: 'New', children: nw?.children ?? [] };
}

/** Right-click menu in the document (select mode): Altium's free-space or object menu. */
export function contextMenu(scope: Scope, onObject = false): AccelNode {
  return contextMenuFor(scope, onObject);
}

/** Status-bar panel buttons, as Altium's System / Design Compiler / SCH / PCB buttons: each a category's panels. */
export function panelButtons(scope: Scope): AccelNode[] {
  return (['System', 'Design Compiler', 'SCH', 'PCB', 'Mixed Sim', 'CAM'] as PanelCategory[])
    .map((c): AccelNode => ({ key: '', label: c, children: panelCategoryItems(c, scope) }))
    .filter((n) => n.children!.length > 0);
}

/**
 * Default shortcuts: Altium Designer 17's (from its resources), then Konium's additions
 * that Altium has elsewhere or that a browser needs (F1 help, ? shortcut sheet).
 */
const DROP = new Set(['+|view.zoomIn', '-|view.zoomOut']);
/**
 * Keys Altium gives a schematic sheet only, which the 'sch' scope would also give the schematic
 * library editor, where Altium has another use for them (Ctrl+Shift+V: Smart Paste on a sheet,
 * Distribute Vertically in a library).
 */
const SHEET_ONLY = new Set(['Ctrl+Shift+V|ad:Sch:PasteSpecial']);
export const DEFAULT_SHORTCUTS: Shortcut[] = [
  ...ad17Shortcuts().filter((s) => !DROP.has(`${s.combo}|${s.command}`))
    .map((s): Shortcut => (SHEET_ONLY.has(`${s.combo}|${s.command}`) ? { ...s, except: ['schlib'] } : s)),
  { combo: 'Ctrl+Shift+S', command: 'file.saveAs' },
  { combo: 'Shift+H', command: 'pcb.headsUp', scopes: ['pcb', 'pcblib'] },
  { combo: 'Insert', command: 'pcb.headsUpReset', scopes: ['pcb', 'pcblib'] },
  { combo: 'Shift+F5', command: 'view.switchPanelFocus' },
  { combo: 'Ctrl+Shift+Z', command: 'edit.redo' },
  { combo: 'Ctrl+D', command: 'edit.duplicate', scopes: ['sch'] },
  { combo: 'Ctrl+D', command: 'pcb.viewOptions', scopes: ['pcb'] },
  // In the schematic and PCB editors (and their libraries): CAM and SimView give Escape to their own Cancel / Clear Filter
  { combo: 'Escape', command: 'edit.deselectAll', scopes: ['sch', 'pcb'] },
  { combo: 'Ctrl+Tab', command: 'window.next' },
  { combo: 'Ctrl+Shift+Tab', command: 'window.prev' },
  { combo: 'Ctrl+W', command: 'route.interactive', scopes: ['pcb'] },
  // AD 18 and later
  { combo: 'Shift+A', command: 'route.active', scopes: ['pcb'] },
  { combo: 'Shift+Space', command: 'edit.rotateSelectionCw', scopes: ['sch'] },
  { combo: 'Enter', command: 'cursor.click', scopes: ['sch', 'pcb'] },
  // AD17's Fold/Unfold (rigid-flex), which the menus here were made without
  { combo: '5', command: 'ad:PCB:FoldUnfold', scopes: ['pcb'] },
  { combo: '0', command: 'view3d.top', scopes: ['pcb'] },
  { combo: '9', command: 'view3d.top90', scopes: ['pcb'] },
  { combo: '8', command: 'view3d.angle', scopes: ['pcb'] },
  { combo: 'F1', command: 'help.guide' },
  { combo: '?', command: 'help.shortcuts' },
];

/** Defaults with the user's overrides applied (an override replaces every default combo of that command). */
export function effectiveShortcuts(): Shortcut[] {
  const ov = settings.shortcuts;
  const out = DEFAULT_SHORTCUTS.filter((s) => !(s.command in ov));
  for (const [command, combo] of Object.entries(ov)) if (combo) out.push({ combo, command, scopes: commands.get(command)?.scopes });
  return out;
}

export const router = new KeyRouter(effectiveShortcuts, () => MENUS);

export function shortcutFor(command: string): string | undefined {
  return effectiveShortcuts().find((s) => s.command === command)?.combo;
}
