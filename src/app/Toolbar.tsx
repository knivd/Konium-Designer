import { commands, type Scope } from '../core/commands';
import type { AccelNode } from '../core/keymap';
import { settings } from '../core/settings';
import { ColourIcon } from './icons';
import { MENUS, fileNewMenu, shortcutFor } from './commands';
import { TIPS, TOOLBARS, type MenuSpec } from './menus/ad17.gen';
import { nodes, parseCaption } from './menus';
import { openMenuAt } from './MenuBar';
import { active, activeScope, chain, tick, type OpenDoc } from './state';

/**
 * Docked toolbars under the menu bar, laid out as Altium Designer 17's (from its resources):
 * Schematic Standard, Wiring and Utilities; PCB Standard, Wiring and Utilities; PCB Lib Standard
 * and Placement. Dropdown buttons (Utility Tools, Alignment, Power Sources, Grids …) open their
 * palette as a menu. Icons are Konium's own drawings that follow Altium's meaning and order.
 */

/** Each toolbar, for View › Toolbars. */
export const TOOLBAR_LIST: { id: string; label: string; scopes: Scope[] }[] = Object.entries(TOOLBARS).map(([id, [label, scope]]) => ({
  id, label, scopes: scope === 'global' ? ['global', 'inspect'] : [scope as Scope],
}));
export const toolbarsFor = (scope: Scope) => TOOLBAR_LIST.filter((b) => b.scopes.includes(scope));
/** Toolbars AD keeps off until View › Toolbars switches them on. */
export const OFF_BY_DEFAULT = new Set(['sch.simSources', 'cam.utilities']);
export const toolbarShown = (id: string): boolean => (OFF_BY_DEFAULT.has(id) ? settings.shownToolbars.includes(id) : !settings.hiddenToolbars.includes(id));

/** Command → icon (also drawn in the menus' icon gutter, as Altium does). */
const ICONS: Record<string, string> = {
  'file.new': 'newDoc', 'file.open': 'open', 'file.openProject': 'openProject', 'file.importWizard': 'importWizard', 'file.exportWizard': 'exportWizard', 'file.save': 'save', 'file.saveAll': 'saveAll', 'file.saveAs': 'saveAs', 'file.close': 'file',
  'ad:PCB:PlaceSplitLine': 'splitLine', 'ad:PCB:DeleteSplitLine': 'deleteSplitLine', 'ad:PCB:PlaceBendingLine': 'bendingLine', 'ad:PCB:FoldUnfold': 'foldUnfold',
  'view.panel.storage': 'storageManager', 'ad:PCB:PlaceBoardRegion': 'boardRegion', 'ad:PCB:SliceBoardRegion': 'sliceRegion', 'ad:PCB:PlaceCoverlayPolygon': 'coverlayPolygon', 'ad:PCB:PlaceCoverlayCutout': 'coverlayCutout',
  'file.openDemo': 'demo', 'file.openSimDemo': 'simDemo', 'file.newStepModel': 'stepDoc',
  'file.newSimModel': 'mdlDoc', 'file.newSimNetlist': 'nsxDoc', 'file.newSimSubcircuit': 'cktDoc',
  'simview.zoomIn': 'simZoomIn', 'simview.zoomOut': 'simZoomOut', 'simview.fit': 'simFit', 'simview.copyText': 'simCopyText', 'sim.abort': 'simAbort', 'text.find': 'findText',
  'simview.addWave': 'waveAdd', 'simview.removeWave': 'waveRemove', 'simview.editWave': 'waveEdit', 'simview.newChart': 'chartNew', 'simview.deleteChart': 'chartDelete',
  'simview.sourceData': 'sourceData', 'simview.cursorMin': 'cursorMin', 'simview.cursorMax': 'cursorMax', 'simview.cursorPeakRight': 'cursorPeakRight',
  'simview.cursorPeakLeft': 'cursorPeakLeft', 'simview.cursorTroughRight': 'cursorTroughRight', 'simview.cursorTroughLeft': 'cursorTroughLeft',
  'sim.source.p5': 'srcP5', 'sim.source.n5': 'srcN5', 'sim.source.p12': 'srcP12', 'sim.source.n12': 'srcN12',
  'sim.source.sin1k': 'srcSin1k', 'sim.source.sin10k': 'srcSin10k', 'sim.source.sin100k': 'srcSin100k', 'sim.source.sin1M': 'srcSin1M',
  'sim.source.pulse1k': 'srcPulse1k', 'sim.source.pulse10k': 'srcPulse10k', 'sim.source.pulse100k': 'srcPulse100k', 'sim.source.pulse1M': 'srcPulse1M', 'view.home': 'home', 'help.support': 'tipJar', 'help.getKonium': 'download', 'help.reportBug': 'bug', 'help.contact': 'contactAuthor', 'help.whatsNew': 'whatsNew', 'help.scripting': 'scriptRef', 'help.guide': 'userGuide', 'tools.scripts': 'scripts', 'ad:WorkspaceManager:PrintNoDialog': 'print', 'ad:WorkspaceManager:PrintPreview': 'printPreview', 'ad:WorkspaceManager:Print': 'printDialog',
  'view.fit': 'fitAll', 'view.fitObjects': 'fitObjects', 'view.fitBoard': 'fitBoard', 'view.area': 'zoomArea', 'view.fitSelection': 'zoomSel', 'ad:PCB:ViewFilteredObjects': 'zoomFiltered',
  'view.zoomIn': 'zoomIn', 'view.zoomOut': 'zoomOut',
  'edit.cut': 'cut', 'edit.copy': 'copy', 'edit.paste': 'paste', 'edit.rubberStamp': 'rubberStamp', 'edit.delete': 'delete',
  'select.insideArea': 'selectArea', 'edit.selectAll': 'selectAll', 'edit.moveSelection': 'moveSel', 'edit.deselectAll': 'deselect', 'pcb.clearHighlight': 'clearFilter',
  'edit.undo': 'undo', 'edit.redo': 'redo', 'ad:Sch:UpDownHierarchy': 'hierarchy', 'tools.crossProbe': 'crossProbe', 'view.panel.library': 'browseLib',
  'view.panel.projects': 'prjpcb', 'tools.preferences': 'gear',
  // Schematic wiring
  'place.wire': 'wire', 'place.bus': 'bus', 'ad:Sch:PlaceSignalHarness': 'harness', 'ad:Sch:PlaceBusEntry': 'busEntry', 'place.netLabel': 'netlabel',
  'place.gnd': 'gnd', 'place.vcc': 'vcc', 'place.part': 'part', 'ad:Sch:PlaceSheetSymbol': 'sheetSymbol', 'ad:Sch:PlaceSheetEntry': 'sheetEntry',
  'ad:Sch:PlaceDeviceSheet': 'deviceSheet', 'ad:Sch:PlaceHarnessConnector': 'harnessConnector', 'ad:Sch:PlaceHarnessEntry': 'harnessEntry', 'place.port': 'port',
  'place.noErc': 'noerc', 'ad:Sch:PlaceNoERCTargeting': 'noercSpecific', 'place.junction': 'junction', 'ad:Sch:ToggleNetColorOverride': 'netColour',
  // Schematic drawing
  'ad:Sch:PlaceLine': 'schLine', 'ad:Sch:PlacePolygon': 'schPolygon', 'ad:Sch:PlaceEllipticalArc': 'schArc', 'ad:Sch:PlaceArc': 'schArcCircular', 'ad:Sch:PlaceBezier': 'bezier',
  'place.text': 'text', 'place.textFrame': 'textFrame', 'ad:Sch:PlaceRectangle': 'rect', 'ad:Sch:PlaceRoundRectangle': 'roundRect', 'ad:Sch:PlaceEllipse': 'ellipse',
  'ad:Sch:PlacePieChart': 'pie', 'ad:Sch:PlaceGraphicImage': 'image', 'ad:Sch:PasteSpecial': 'smartPaste',
  // Alignment
  'align.left': 'alignLeft', 'align.right': 'alignRight', 'align.top': 'alignTop', 'align.bottom': 'alignBottom', 'align.hCentre': 'alignHCentre', 'align.vCentre': 'alignVCentre',
  'align.distributeH': 'distributeH', 'align.distributeV': 'distributeV', 'align.toGrid': 'toGrid',
  'ad:PCB:ArrangeComponentsWithinRoom': 'roomArrange', 'ad:PCB:AlignComponentsDialog': 'alignTools',
  // Grids
  'view.grid': 'gridTool', 'view.gridReverse': 'gridReverse', 'view.visibleGrid': 'gridVisible',
  // PCB
  'pcb.viewConfigurations': 'layers', 'pcb.layerStackManager': 'stack', 'design.rules': 'rules', 'tools.drc': 'drc', 'reports.measure': 'measure', 'output.gerber': 'gerber',
  'output.drill': 'drill', 'output.pnp': 'pnp', 'reports.bom': 'bom', 'tools.erc': 'compile', 'tools.annotate': 'annotate', 'tools.annotateQuietly': 'annotateQuiet',
  'design.updatePcb': 'updatePcb', 'route.interactive': 'route', 'route.multi': 'multiRoute', 'route.diffPair': 'diffPair', 'place.wireLink': 'wireLink', 'place.pad': 'pad', 'place.via': 'via',
  'place.arc': 'arc', 'place.fill': 'fill', 'place.polygon': 'polygon', 'place.component': 'component', 'place.track': 'line', 'ad:PCB:PlaceSolidRegion': 'solidRegion',
  'ad:PCB:PlaceCoordinate': 'coordinate', 'ad:PCB:PlaceDimension': 'dimGeneric', 'pcb.setOrigin': 'origin', 'ad:PCB:PlaceArcCenter': 'arcCentre',
  'ad:PCB:PlaceArcAnyAngle': 'arcAny', 'ad:PCB:PlaceFullCircle': 'circle', 'ad:PCB:PasteArray': 'pasteArray',
  'ad:PCB:JumpFirstSelection': 'selFirst', 'ad:PCB:JumpPreviousSelection': 'selPrev', 'ad:PCB:JumpNextSelection': 'selNext', 'ad:PCB:JumpLastSelection': 'selLast',
  'wm.compileProject': 'compile', 'wm.recompileProject': 'compile', 'tools.recompile': 'compile', 'wm.saveProject': 'saveProject', 'wm.saveDoc': 'save', 'wm.saveDocAs': 'saveAs',
  'wm.openDoc': 'open', 'wm.openProjectDocs': 'openProjectDocs', 'wm.saveCategory': 'saveAll', 'msg.copy': 'copy', 'window.closeAll': 'closeAll',
  'ad:PCB:JumpFirstGroup': 'grpFirst', 'ad:PCB:JumpPreviousGroup': 'grpPrev', 'ad:PCB:JumpNextGroup': 'grpNext', 'ad:PCB:JumpLastGroup': 'grpLast',
  // Power ports, each its style
  'ad:Sch:PlacePowerPort_GNDBusPowerPort': 'gndBus', 'ad:Sch:PlacePowerPort_VCCBusPowerPort': 'vccBus', 'ad:Sch:PlacePowerPort_+12PowerPort': 'pwr12',
  'ad:Sch:PlacePowerPort_+5PowerPort': 'pwr5', 'ad:Sch:PlacePowerPort_-5PowerPort': 'pwrMinus5', 'ad:Sch:PlacePowerPort_ArrowStylePowerPort': 'pwrArrow',
  'ad:Sch:PlacePowerPort_WaveStylePowerPort': 'pwrWave', 'ad:Sch:PlacePowerPort_BarStylePowerPort': 'pwrBar', 'ad:Sch:PlacePowerPort_CircleStylePowerPort': 'pwrCircle',
  'ad:Sch:PlacePowerPort_SignalGroundPowerPort': 'sigGnd', 'ad:Sch:PlacePowerPort_EarthPowerPort': 'earth',
  // Net colours, grids
  'ad:Sch:SetNetColors_ChooseColor': 'netColourCustom', 'ad:Sch:ClearNetColors': 'netColourClear', 'ad:Sch:ClearAllNetColors': 'netColourClearAll',
  'ad:Sch:ToggleElectricalGrid': 'electricalGrid', 'ad:Sch:SetSnapGrid': 'gridSet', 'ad:PCB:ToggleVisibleGridKind': 'gridKind', 'ad:PCB:ToggleElectricalGrid': 'hotspot',
  'ad:PCB:PopupSnapGridOther': 'gridSet',
  // Spacing, unions, arranging
  'ad:PCB:AlignComponentsExpandHorizontal': 'spaceIncH', 'ad:PCB:AlignComponentsContractHorizontal': 'spaceDecH', 'ad:PCB:AlignComponentsExpandVertical': 'spaceIncV',
  'ad:PCB:AlignComponentsContractVertical': 'spaceDecV', 'ad:PCB:ArrangeComponentsWithinRectangle': 'arrangeRect', 'ad:PCB:CreateUnion': 'unionMake', 'ad:PCB:BreakUnion': 'unionBreak',
  // Dimensions and rooms
  'ad:PCB:PlaceDimensionLinear': 'dimension', 'ad:PCB:PlaceDimensionAngular': 'dimAngular', 'ad:PCB:PlaceDimensionRadial': 'dimRadial', 'ad:PCB:PlaceDimensionLeader': 'dimLeader',
  'ad:PCB:PlaceDimensionDatum': 'dimDatum', 'ad:PCB:PlaceDimensionBaseline': 'dimBaseline', 'ad:PCB:PlaceDimensionCenter': 'dimCenter',
  'ad:PCB:PlaceDimensionLinearDiameter': 'dimLinDia', 'ad:PCB:PlaceDimensionRadialDiameter': 'dimRadDia',
  'ad:PCB:PlaceRectangularRoom': 'room', 'ad:PCB:PlacePolygonalRoom': 'roomPoly', 'ad:PCB:ChannelFormatCopier': 'roomCopy', 'ad:PCB:CreateRoomFromComponentsOrtho': 'roomOrtho',
  'ad:PCB:CreateRoomFromComponentsNonOrtho': 'roomNonOrtho', 'ad:PCB:CreateRoomFromComponentsBoundingRect': 'roomBounding', 'ad:PCB:CutRoom': 'roomSlice',
  'ad:PCB:CutSingleRoom': 'roomSlice', 'ad:PCB:SmartCutSingleRoom': 'roomSmartCut',
  'ad:PCB:MoveRoom': 'roomMove', 'ad:PCB:MoveSingleRoom': 'roomMove', 'ad:PCB:EditRoomVertices': 'roomVertices', 'ad:PCB:EditSingleRoomVertices': 'roomVertices',
  'ad:PCB:ArrangeRooms': 'roomArrangeRooms', 'ad:PCB:MoveRoomsToGrid': 'roomToGrid', 'ad:PCB:ConvertSelectedToRoom': 'roomConvert', 'ad:PCB:FanoutRoom': 'roomFanout',
  'ad:PCB:WrapRoomsAroundComponentsNonOrtho': 'roomWrapNonOrtho', 'ad:PCB:WrapSingleRoomAroundComponentsNonOrtho': 'roomWrapNonOrtho',
  'ad:PCB:WrapRoomsAroundComponentsOrtho': 'roomWrapOrtho', 'ad:PCB:WrapSingleRoomAroundComponentsOrtho': 'roomWrapOrtho',
  'ad:PCB:WrapRoomsAroundComponentsBoundingRect': 'roomWrapBounding', 'ad:PCB:WrapSingleRoomAroundComponentsBoundingRect': 'roomWrapBounding',
  'ad:PCB:AutorouteRoom': 'roomAutoroute', 'ad:PCB:AutorouteSingleRoom': 'roomAutoroute', 'ad:PCB:UnRouteRoom': 'roomUnroute', 'ad:PCB:UnRouteSingleRoom': 'roomUnroute',
  'ad:PCB:SelectRoomConnections': 'roomSelectConn', 'ad:PCB:SelectSingleRoomConnections': 'roomSelectConn',
  // Library editors
  'schlib.newComponent': 'newComponent', 'schlib.newPart': 'newPart', 'place.pin': 'pinTool', 'ad:Sch:ModelManager': 'modelManager',
  'ad:Sch:ToggleComponentMode0': 'mode', 'ad:Sch:ToggleComponentAddMode': 'modeAdd', 'ad:Sch:ToggleComponentRemoveMode': 'modeRemove',
  'ad:Sch:ToggleComponentPreviousMode': 'modePrev', 'ad:Sch:ToggleComponentNextMode': 'modeNext',
  // CAMtastic Standard
  'ad:CAMTASTIC:FilePrint': 'camPrint', 'ad:CAMTASTIC:FilePrintPreview': 'camPrintPreview', 'ad:CAMTASTIC:ZoomDynamicPan': 'camDynamicPan',
  'ad:CAMTASTIC:EditCut': 'camCut', 'ad:CAMTASTIC:EditCopy': 'camCopy', 'ad:CAMTASTIC:EditPaste': 'camPaste', 'cam.query': 'camQuery', 'ad:CAMTASTIC:InfoPCBReport': 'camRfq',
};
/** Same command, another picture in another editor (Place › String on a PCB). */
const SCOPE_ICONS: Partial<Record<Scope, Record<string, string>>> = { pcb: { 'place.text': 'string' }, pcblib: { 'place.text': 'string' } };
/** Dropdown buttons, by their Altium hint. */
const DROP_ICONS: Record<string, string> = {
  'Utility Tools': 'drawTools', 'Alignment Tools': 'alignTools', 'Power Sources': 'powerTools', Grids: 'gridTool', 'Net Colours': 'netColour',
  'Find Selection': 'selNext', 'Place Dimension': 'dimension', 'Place Room': 'room', 'IEEE Symbols': 'ieee', Mode: 'mode', '': 'gridTool',
};

export function iconFor(cmd: string, scope?: Scope): string | undefined {
  const s = scope ? SCOPE_ICONS[scope]?.[cmd] : undefined;
  if (s) return s;
  const i = ICONS[cmd];
  if (i) return i;
  const ieee = /^ad:Sch:PlaceIEEE(\w+?)(Symbol)?$/.exec(cmd);
  if (ieee) return `ieee${ieee[1]}`;
  if (/PowerPort/.test(cmd)) return /GND|Ground|Earth/i.test(cmd) ? 'gnd' : 'vcc';
  if (/PlaceDimension/.test(cmd)) return 'dimension';
  // Snap grid sizes carry no picture (as in AD17's grid menus)
  if (cmd.startsWith('grid.set:')) return undefined;
  return undefined;
}

/** "P, W" style chain for a command, from the menus. */
export function chainFor(cmd: string, scope: Scope): string | undefined {
  const walk = (n: AccelNode, prefix: string[], depth: number): string | undefined => {
    if (depth > 4) return undefined;
    for (const c of n.children ?? []) {
      if (!c.key) continue;
      const seq = [...prefix, c.key];
      if (c.command === cmd) return seq.join(', ');
      if (c.children) { const r = walk(c, seq, depth + 1); if (r) return r; }
    }
    return undefined;
  };
  for (const m of MENUS) if (m.inMenuBar && m.key && m.scopes.includes(scope)) { const r = walk(m, [m.key], 0); if (r) return r; }
  return undefined;
}

const tipCache = new Map<string, string | undefined>();
function keyHint(cmd: string, scope: Scope): string | undefined {
  const k = `${scope}|${cmd}`;
  if (!tipCache.has(k)) tipCache.set(k, chainFor(cmd, scope));
  return shortcutFor(cmd) ?? tipCache.get(k);
}

/** Commands whose tool shows the button pressed while it runs. */
const TOOL_OF: Record<string, string> = {
  'place.wire': 'place-wire', 'place.bus': 'place-bus', 'route.interactive': 'route', 'place.track': 'place-track', 'place.pad': 'place-pad', 'place.polygon': 'place-polygon',
  'view.area': 'zoom-area', 'select.insideArea': 'select-area', 'place.via': 'place-via', 'place.fill': 'place-fill', 'place.arc': 'place-arc-edge',
  'ad:PCB:PlaceArcCenter': 'place-arc-centre', 'ad:PCB:PlaceArcAnyAngle': 'place-arc-any', 'ad:PCB:PlaceFullCircle': 'place-circle', 'ad:PCB:PlaceSolidRegion': 'place-region',
  'place.wireLink': 'place-wire-link',
};

const tipText = (caption: string) => parseCaption(caption).label.replace(/\.\.\.$/, '');
/** AD17's tooltip: the command's Description from its resources, else its caption. */
const tipFor = (caption: string, cmd: string, scope: Scope) => TIPS[`${scope === 'inspect' ? 'global' : scope}|${cmd}`] ?? tipText(caption);

function Button({ spec, scope, toolId }: { spec: [string, string]; scope: Scope; toolId?: string }) {
  const [caption, cmdId] = spec;
  const c = commands.get(cmdId);
  if (!c) return null;
  const icon = /^&?Browse/.test(caption) ? 'browseLib' : iconFor(cmdId, scope);
  if (!icon) return null;
  const live = commands.isLive(cmdId, scope);
  const on = !!toolId && (TOOL_OF[cmdId] === toolId || toolId === cmdId || (cmdId === 'place.text' && toolId === 'place-string'));
  const sc = keyHint(cmdId, scope);
  const tip = `${tipFor(caption, cmdId, scope)}${sc ? ` (${sc})` : ''}${c.planned ? ' — not in Konium Designer yet' : ''}`;
  const isNew = cmdId === 'file.new';
  const off = !live && !c.planned;
  // Greyed but still hoverable (a disabled button shows no tooltip in some browsers)
  return (
    <button class={`tbtn${on ? ' on' : ''}${isNew ? ' tbtn-drop' : ''}${off ? ' off' : ''}`} title={tip} aria-label={tipText(caption)} aria-pressed={on || undefined}
      aria-disabled={off || undefined} data-planned={c.planned ? '' : undefined} data-cmd={cmdId}
      onMouseDown={(e) => {
        e.preventDefault();
        if (off) return;
        if (isNew) { const b = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenuAt(fileNewMenu(scope), b.left, b.bottom + 1); return; }
        if (c.planned) void c.run(); else commands.run(cmdId, scope);
      }}>
      <ColourIcon name={icon} />
    </button>
  );
}

function Dropdown({ spec, scope }: { spec: [string, MenuSpec[]]; scope: Scope }) {
  const [hint, kids] = spec;
  const open = chain.value?.path[0]?.label === hint && !!hint;
  return (
    <button class={`tbtn tbtn-drop${open ? ' on' : ''}`} title={hint || 'Grids'} aria-label={hint || 'Grids'} aria-haspopup="menu"
      onMouseDown={(e) => {
        e.preventDefault();
        const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenuAt({ key: '', label: hint || 'Grids', children: nodes(kids, scope) }, b.left, b.bottom + 1);
      }}>
      <ColourIcon name={DROP_ICONS[hint] ?? 'drawTools'} /><span class="tbtn-arrow" aria-hidden="true" />
    </button>
  );
}

/** A window's toolbars: those of the document it shows (scope, od), else the active document's. */
export function Toolbars({ scope: own, od }: { scope?: Scope; od?: OpenDoc | null } = {}) {
  void tick.value;
  void chain.value;
  const scope = own ?? activeScope.value;
  const toolId = (od === undefined ? active.value : od)?.editor?.tool.id;
  const bars = toolbarsFor(scope).filter((b) => toolbarShown(b.id));
  return (
    <div class="toolbars" role="toolbar" aria-label="Toolbars" data-ctx="toolbars">
      {bars.map((bar) => {
        const items = TOOLBARS[bar.id]![2];
        // A toolbar none of whose buttons Konium draws yet (SimView's wave and cursor tools) stays away
        if (!items.some((s) => s !== 0 && s.length > 1 && (Array.isArray(s[1]) || !!iconFor(s[1] as string, scope)))) return null;
        const groups: MenuSpec[][] = [[]];
        for (const s of items) { if (s === 0) groups.push([]); else groups.at(-1)!.push(s); }
        return (
          <div key={bar.id} class="tbar" aria-label={bar.label} data-bar={bar.id}>
            <span class="tbar-grip" aria-hidden="true" />
            {groups.filter((g) => g.length).map((g, gi) => (
              <span key={gi} class="tgroup">
                {g.map((s, i) => {
                  if (s === 0 || s.length === 1) return null;
                  if (Array.isArray(s[1])) return <Dropdown key={i} spec={s as [string, MenuSpec[]]} scope={scope} />;
                  return <Button key={i} spec={s as [string, string]} scope={scope} toolId={toolId} />;
                })}
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}
